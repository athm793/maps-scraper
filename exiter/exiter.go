package exiter

import (
	"context"
	"sync"
)

type Exiter interface {
	SetSeedCount(int)
	SetCancelFunc(context.CancelFunc)
	IncrSeedCompleted(int)
	IncrPlacesFound(int)
	IncrPlacesCompleted(int)
	Run(context.Context)
	Snapshot() Progress
}

// Progress is a point-in-time view of a running job's counters.
type Progress struct {
	SeedCount       int `json:"seed_count"`
	SeedCompleted   int `json:"seed_completed"`
	PlacesFound     int `json:"places_found"`
	PlacesCompleted int `json:"places_completed"`
}

type exiter struct {
	seedCount       int
	seedCompleted   int
	placesFound     int
	placesCompleted int

	mu         *sync.Mutex
	cancelFunc context.CancelFunc
	doneCh     chan struct{}
}

func New() Exiter {
	return &exiter{
		mu:     &sync.Mutex{},
		doneCh: make(chan struct{}, 1),
	}
}

func (e *exiter) SetSeedCount(val int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.seedCount = val
}

func (e *exiter) SetCancelFunc(fn context.CancelFunc) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.cancelFunc = fn
}

func (e *exiter) IncrSeedCompleted(val int) {
	e.mu.Lock()
	e.seedCompleted += val
	done := e.seedCompleted >= e.seedCount && e.placesCompleted >= e.placesFound
	e.mu.Unlock()

	if done {
		select {
		case e.doneCh <- struct{}{}:
		default:
		}
	}
}

func (e *exiter) IncrPlacesFound(val int) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.placesFound += val
}

func (e *exiter) IncrPlacesCompleted(val int) {
	e.mu.Lock()
	e.placesCompleted += val
	done := e.seedCompleted >= e.seedCount && e.placesCompleted >= e.placesFound
	e.mu.Unlock()

	if done {
		select {
		case e.doneCh <- struct{}{}:
		default:
		}
	}
}

func (e *exiter) Snapshot() Progress {
	e.mu.Lock()
	defer e.mu.Unlock()

	return Progress{
		SeedCount:       e.seedCount,
		SeedCompleted:   e.seedCompleted,
		PlacesFound:     e.placesFound,
		PlacesCompleted: e.placesCompleted,
	}
}

func (e *exiter) Run(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-e.doneCh:
		if e.cancelFunc != nil {
			e.cancelFunc()
		}
	}
}
