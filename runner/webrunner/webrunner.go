package webrunner

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gosom/google-maps-scraper/deduper"
	"github.com/gosom/google-maps-scraper/exiter"
	"github.com/gosom/google-maps-scraper/runner"
	"github.com/gosom/google-maps-scraper/tlmt"
	"github.com/gosom/google-maps-scraper/web"
	"github.com/gosom/google-maps-scraper/web/sqlite"
	"github.com/gosom/scrapemate"
	"github.com/gosom/scrapemate/adapters/writers/csvwriter"
	"github.com/gosom/scrapemate/scrapemateapp"
	"golang.org/x/sync/errgroup"
)

type webrunner struct {
	srv       *web.Server
	svc       *web.Service
	cfg       *runner.Config
	setupMate func(context.Context, io.Writer, *web.Job, []string) (mateRunner, error)

	// cached proxy-pool health so we don't re-test for every job in a burst
	proxyMu      sync.Mutex
	proxyChecked time.Time
	proxyHealthy bool
	proxyErr     string
}

type mateRunner interface {
	Start(context.Context, ...scrapemate.IJob) error
	Close() error
}

func New(cfg *runner.Config) (runner.Runner, error) {
	if cfg.DataFolder == "" {
		return nil, fmt.Errorf("data folder is required")
	}

	if err := os.MkdirAll(cfg.DataFolder, os.ModePerm); err != nil {
		return nil, err
	}

	const dbfname = "jobs.db"

	dbpath := filepath.Join(cfg.DataFolder, dbfname)

	repo, err := sqlite.New(dbpath)
	if err != nil {
		return nil, err
	}

	svc := web.NewService(repo, cfg.DataFolder)

	srv, err := web.New(svc, cfg.Addr)
	if err != nil {
		return nil, err
	}

	ans := webrunner{
		srv:       srv,
		svc:       svc,
		cfg:       cfg,
		setupMate: defaultSetupMate(cfg),
	}

	return &ans, nil
}

func (w *webrunner) Run(ctx context.Context) error {
	egroup, ctx := errgroup.WithContext(ctx)

	egroup.Go(func() error {
		return w.work(ctx)
	})

	egroup.Go(func() error {
		return w.srv.Start(ctx)
	})

	return egroup.Wait()
}

func (w *webrunner) Close(context.Context) error {
	return nil
}

// resetOrphans re-queues jobs left in the "working" state by a previous process
// (e.g. a restart). The runner only ever picks up pending jobs, so without this
// an interrupted job would stay "working" forever and never finish.
func (w *webrunner) resetOrphans(ctx context.Context) {
	jobs, err := w.svc.All(ctx)
	if err != nil {
		log.Printf("reset orphans: %v", err)

		return
	}

	for i := range jobs {
		if jobs[i].Status != web.StatusWorking {
			continue
		}

		jobs[i].Status = web.StatusPending
		if err := w.svc.Update(ctx, &jobs[i]); err != nil {
			log.Printf("reset orphan %s: %v", jobs[i].ID, err)
		}
	}
}

func (w *webrunner) work(ctx context.Context) error {
	w.resetOrphans(ctx)

	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			jobs, err := w.svc.SelectPending(ctx)
			if err != nil {
				return err
			}

			for i := range jobs {
				select {
				case <-ctx.Done():
					return nil
				default:
					t0 := time.Now().UTC()
					if err := w.scrapeJob(ctx, &jobs[i]); err != nil {
						params := map[string]any{
							"job_count": len(jobs[i].Data.Keywords),
							"duration":  time.Now().UTC().Sub(t0).String(),
							"error":     err.Error(),
						}

						evt := tlmt.NewEvent("web_runner", params)

						_ = runner.Telemetry().Send(ctx, evt)

						log.Printf("error scraping job %s: %v", jobs[i].ID, err)
					} else {
						params := map[string]any{
							"job_count": len(jobs[i].Data.Keywords),
							"duration":  time.Now().UTC().Sub(t0).String(),
						}

						_ = runner.Telemetry().Send(ctx, tlmt.NewEvent("web_runner", params))

						log.Printf("job %s scraped successfully", jobs[i].ID)
					}
				}
			}
		}
	}
}

func (w *webrunner) scrapeJob(ctx context.Context, job *web.Job) error {
	job.Status = web.StatusWorking

	if err := w.svc.Update(ctx, job); err != nil {
		return err
	}

	if len(job.Data.Keywords) == 0 {
		job.Status = web.StatusFailed
		job.Data.Note = "No searches to run."

		return w.svc.Update(ctx, job)
	}

	// Decide which proxies to use. If a pool is configured but its health probe
	// fails, skip it and run directly from this machine's IP.
	proxies := w.cfg.Proxies
	if len(proxies) == 0 {
		proxies = job.Data.Proxies
	}

	effectiveProxies := proxies
	usedProxies := len(proxies) > 0
	note := ""

	if len(proxies) > 0 {
		if healthy, perr := w.poolHealthy(ctx, proxies); !healthy {
			effectiveProxies = nil
			usedProxies = false
			note = "Proxies unavailable (" + perr + "). Ran directly with this machine's IP."

			log.Printf("job %s: %s", job.ID, note)
		}
	}

	job.Data.Note = note
	_ = w.svc.Update(ctx, job)

	results, err := w.runOnce(ctx, job, effectiveProxies)
	if err != nil {
		job.Status = web.StatusFailed
		job.Data.Note = err.Error()

		return w.svc.Update(ctx, job)
	}

	// Outcome-based fallback: a proxied run that produced nothing almost always
	// means the proxies failed mid-scrape (402 bandwidth exhausted, or blocked).
	// A light pre-flight probe cannot predict this, so re-run once directly using
	// this machine's IP. A fully-blocked run aborts on inactivity within minutes,
	// so this retry is cheap.
	if usedProxies && results == 0 {
		note = "Proxies returned no data (out of bandwidth or blocked). Re-ran directly with this machine's IP."

		log.Printf("job %s: %s", job.ID, note)

		job.Data.Note = note
		_ = w.svc.Update(ctx, job)

		if results, err = w.runOnce(ctx, job, nil); err != nil {
			job.Status = web.StatusFailed
			job.Data.Note = err.Error()

			return w.svc.Update(ctx, job)
		}
	}

	_ = results

	job.Status = web.StatusOK
	job.Data.Note = note

	return w.svc.Update(ctx, job)
}

// runOnce executes the job's searches one time, writing results to the job's CSV
// (truncating any previous attempt), and returns how many places were found. A
// hit time limit or cancellation is a normal finish, not an error.
func (w *webrunner) runOnce(ctx context.Context, job *web.Job, proxies []string) (int, error) {
	outpath := filepath.Join(w.cfg.DataFolder, job.ID+".csv")

	outfile, err := os.Create(outpath)
	if err != nil {
		return 0, fmt.Errorf("failed to create output file: %w", err)
	}

	defer func() {
		_ = outfile.Close()
	}()

	setupMate := w.setupMate
	if setupMate == nil {
		setupMate = defaultSetupMate(w.cfg)
	}

	mate, err := setupMate(ctx, outfile, job, proxies)
	if err != nil {
		return 0, fmt.Errorf("failed to start scraper: %w", err)
	}

	defer mate.Close()

	var coords string
	if job.Data.Lat != "" && job.Data.Lon != "" {
		coords = job.Data.Lat + "," + job.Data.Lon
	}

	dedup := deduper.New()
	exitMonitor := exiter.New()

	// expose live progress to the dashboard while this job runs
	w.svc.SetJobProgress(job.ID, exitMonitor)
	defer w.svc.ClearJobProgress(job.ID)

	seedJobs, err := runner.CreateSeedJobs(
		job.Data.FastMode,
		job.Data.Lang,
		strings.NewReader(strings.Join(job.Data.Keywords, "\n")),
		job.Data.Depth,
		job.Data.Email,
		coords,
		job.Data.Zoom,
		func() float64 {
			if job.Data.Radius <= 0 {
				return 10000 // 10 km
			}

			return float64(job.Data.Radius)
		}(),
		dedup,
		exitMonitor,
		w.cfg.ExtraReviews || job.Data.ExtraReviews,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to prepare searches: %w", err)
	}

	if len(seedJobs) > 0 {
		exitMonitor.SetSeedCount(len(seedJobs))

		allowedSeconds := max(60, len(seedJobs)*10*job.Data.Depth/50+120)

		if job.Data.MaxTime > 0 {
			if job.Data.MaxTime.Seconds() < 180 {
				allowedSeconds = 180
			} else {
				allowedSeconds = int(job.Data.MaxTime.Seconds())
			}
		}

		log.Printf("running job %s with %d seed jobs and %d allowed seconds", job.ID, len(seedJobs), allowedSeconds)

		mateCtx, cancel := context.WithTimeout(ctx, time.Duration(allowedSeconds)*time.Second)
		defer cancel()

		exitMonitor.SetCancelFunc(cancel)

		go exitMonitor.Run(mateCtx)

		// When running through proxies, bail out fast if they are clearly not
		// working (searches complete but nothing is ever found) so the caller can
		// retry directly instead of burning the whole time budget on 402s.
		if len(proxies) > 0 {
			go abortIfProxiesDead(mateCtx, job.ID, exitMonitor, cancel)
		}

		err = mate.Start(mateCtx, seedJobs...)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			cancel()

			return 0, fmt.Errorf("scrape failed: %w", err)
		}

		cancel()
	}

	return exitMonitor.Snapshot().PlacesFound, nil
}

func defaultSetupMate(cfg *runner.Config) func(context.Context, io.Writer, *web.Job, []string) (mateRunner, error) {
	return func(_ context.Context, writer io.Writer, job *web.Job, proxies []string) (mateRunner, error) {
		opts := []func(*scrapemateapp.Config) error{
			scrapemateapp.WithConcurrency(cfg.Concurrency),
			scrapemateapp.WithExitOnInactivity(time.Minute * 3),
		}

		if !job.Data.FastMode {
			opts = append(opts,
				scrapemateapp.WithJS(scrapemateapp.DisableImages()),
			)
		} else {
			opts = append(opts,
				scrapemateapp.WithStealth("firefox"),
			)
		}

		opts = runner.AppendBrowserCapacityOptions(opts, cfg)

		hasProxy := false

		if len(proxies) > 0 {
			opts = append(opts, scrapemateapp.WithProxies(proxies))
			hasProxy = true
		}

		if !cfg.DisablePageReuse {
			opts = append(opts,
				scrapemateapp.WithPageReuseLimit(2),
				scrapemateapp.WithBrowserReuseLimit(200),
			)
		}

		log.Printf("job %s has proxy: %v", job.ID, hasProxy)

		csvWriter := csvwriter.NewCsvWriter(csv.NewWriter(writer))

		writers := []scrapemate.ResultWriter{csvWriter}

		matecfg, err := scrapemateapp.NewConfig(
			writers,
			opts...,
		)
		if err != nil {
			return nil, err
		}

		return scrapemateapp.NewScrapeMateApp(matecfg)
	}
}

// abortIfProxiesDead cancels a proxied run once enough searches have completed
// with zero results — a strong sign the proxies are failing (e.g. 402 bandwidth
// exhausted) rather than the area genuinely having no places.
func abortIfProxiesDead(ctx context.Context, jobID string, mon exiter.Exiter, cancel context.CancelFunc) {
	const minSeeds = 15

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s := mon.Snapshot()
			if s.SeedCompleted >= minSeeds && s.PlacesFound == 0 {
				log.Printf("job %s: %d searches completed with 0 results via proxies; aborting for direct retry", jobID, s.SeedCompleted)
				cancel()

				return
			}
		}
	}
}

// poolHealthy reports whether the configured proxy pool can reach the internet,
// caching the verdict briefly so a burst of jobs does not re-probe every time.
func (w *webrunner) poolHealthy(ctx context.Context, proxies []string) (bool, string) {
	w.proxyMu.Lock()
	if !w.proxyChecked.IsZero() && time.Since(w.proxyChecked) < 90*time.Second {
		h, e := w.proxyHealthy, w.proxyErr
		w.proxyMu.Unlock()

		return h, e
	}
	w.proxyMu.Unlock()

	healthy, errMsg := probeProxies(ctx, proxies)

	w.proxyMu.Lock()
	w.proxyChecked = time.Now()
	w.proxyHealthy = healthy
	w.proxyErr = errMsg
	w.proxyMu.Unlock()

	return healthy, errMsg
}

// probeProxies tests an evenly spread sample of the pool. If any proxy tunnels a
// request successfully the pool is considered usable; otherwise it returns a
// concise reason (e.g. a 402 bandwidth-exhausted message).
func probeProxies(ctx context.Context, proxies []string) (bool, string) {
	const sampleN = 8

	sample := proxies
	if len(sample) > sampleN {
		step := len(sample) / sampleN
		s := make([]string, 0, sampleN)

		for i := 0; i < len(sample) && len(s) < sampleN; i += step {
			s = append(s, sample[i])
		}

		sample = s
	}

	type res struct {
		ok  bool
		err string
	}

	ch := make(chan res, len(sample))

	var wg sync.WaitGroup

	for _, p := range sample {
		wg.Add(1)

		go func(p string) {
			defer wg.Done()

			ok, err := probeOne(ctx, p)
			ch <- res{ok: ok, err: err}
		}(p)
	}

	wg.Wait()
	close(ch)

	okCount := 0

	var lastErr string

	for r := range ch {
		if r.ok {
			okCount++
		} else if r.err != "" {
			lastErr = r.err
		}
	}

	// Require a majority of the sample to work. A single light request can
	// succeed against a nearly-exhausted pool, so "any one works" is too lenient:
	// the pool would then be used for a real scrape and fail with 402 mid-run.
	if okCount*2 >= len(sample) {
		return true, ""
	}

	return false, summarizeProxyErr(lastErr)
}

func probeOne(ctx context.Context, proxy string) (bool, string) {
	u, err := url.Parse(proxy)
	if err != nil {
		return false, err.Error()
	}

	client := &http.Client{
		Timeout: 12 * time.Second,
		Transport: &http.Transport{
			Proxy:             http.ProxyURL(u),
			DisableKeepAlives: true,
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.google.com/generate_204", nil)
	if err != nil {
		return false, err.Error()
	}

	resp, err := client.Do(req)
	if err != nil {
		return false, err.Error()
	}

	_ = resp.Body.Close()

	return true, ""
}

func summarizeProxyErr(e string) string {
	le := strings.ToLower(e)

	switch {
	case strings.Contains(e, "402") || strings.Contains(le, "payment required"):
		return "402 Payment Required — proxy bandwidth exhausted"
	case strings.Contains(e, "407"):
		return "407 — proxy auth failed; is this machine's IP authorized?"
	case strings.Contains(le, "timeout") || strings.Contains(le, "deadline") || strings.Contains(le, "i/o timeout"):
		return "proxies timed out / unreachable"
	case e == "":
		return "all sampled proxies failed"
	default:
		if i := strings.LastIndex(e, ": "); i >= 0 && i < len(e)-2 {
			e = e[i+2:]
		}

		return e
	}
}
