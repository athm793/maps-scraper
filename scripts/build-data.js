// Builds embedded data files for the web UI pickers (WORLDWIDE):
//   web/static/data/categories.json     - full GBP category list (flat, sorted)
//   web/static/data/countries.json      - [{c,n,cities,zips}] summary index
//   web/static/data/loc/<CC>.json        - per-country {c,n,a:[{n,c,ct:[[city,[zips]]]}]}
// Lazy-loaded: the browser fetches loc/<CC>.json only for countries the user opens.
// Run with: node scripts/build-data.js
const fs = require("fs");
const path = require("path");

const CATEGORIES_CSV = process.env.CATEGORIES_CSV ||
  "E:/Google Business Profile Categories (2026 List) - Category List (English).csv";
const GEONAMES_CSV = process.env.GEONAMES_CSV || "E:/geonames-postal-code.csv";
const OUT_DIR = path.join(__dirname, "..", "web", "static", "data");
const LOC_DIR = path.join(OUT_DIR, "loc");

const ISO = {
  AD:"Andorra",AE:"United Arab Emirates",AF:"Afghanistan",AG:"Antigua and Barbuda",AI:"Anguilla",AL:"Albania",AM:"Armenia",AO:"Angola",AR:"Argentina",AS:"American Samoa",AT:"Austria",AU:"Australia",AW:"Aruba",AX:"Åland Islands",AZ:"Azerbaijan",BA:"Bosnia and Herzegovina",BB:"Barbados",BD:"Bangladesh",BE:"Belgium",BF:"Burkina Faso",BG:"Bulgaria",BH:"Bahrain",BI:"Burundi",BJ:"Benin",BL:"Saint Barthélemy",BM:"Bermuda",BN:"Brunei",BO:"Bolivia",BQ:"Caribbean Netherlands",BR:"Brazil",BS:"Bahamas",BT:"Bhutan",BW:"Botswana",BY:"Belarus",BZ:"Belize",CA:"Canada",CC:"Cocos Islands",CD:"DR Congo",CF:"Central African Republic",CG:"Congo",CH:"Switzerland",CI:"Côte d'Ivoire",CK:"Cook Islands",CL:"Chile",CM:"Cameroon",CN:"China",CO:"Colombia",CR:"Costa Rica",CU:"Cuba",CV:"Cape Verde",CW:"Curaçao",CX:"Christmas Island",CY:"Cyprus",CZ:"Czechia",DE:"Germany",DJ:"Djibouti",DK:"Denmark",DM:"Dominica",DO:"Dominican Republic",DZ:"Algeria",EC:"Ecuador",EE:"Estonia",EG:"Egypt",EH:"Western Sahara",ER:"Eritrea",ES:"Spain",ET:"Ethiopia",FI:"Finland",FJ:"Fiji",FK:"Falkland Islands",FM:"Micronesia",FO:"Faroe Islands",FR:"France",GA:"Gabon",GB:"United Kingdom",GD:"Grenada",GE:"Georgia",GF:"French Guiana",GG:"Guernsey",GH:"Ghana",GI:"Gibraltar",GL:"Greenland",GM:"Gambia",GN:"Guinea",GP:"Guadeloupe",GQ:"Equatorial Guinea",GR:"Greece",GT:"Guatemala",GU:"Guam",GW:"Guinea-Bissau",GY:"Guyana",HK:"Hong Kong",HN:"Honduras",HR:"Croatia",HT:"Haiti",HU:"Hungary",ID:"Indonesia",IE:"Ireland",IL:"Israel",IM:"Isle of Man",IN:"India",IO:"British Indian Ocean Territory",IQ:"Iraq",IR:"Iran",IS:"Iceland",IT:"Italy",JE:"Jersey",JM:"Jamaica",JO:"Jordan",JP:"Japan",KE:"Kenya",KG:"Kyrgyzstan",KH:"Cambodia",KI:"Kiribati",KM:"Comoros",KN:"Saint Kitts and Nevis",KP:"North Korea",KR:"South Korea",KW:"Kuwait",KY:"Cayman Islands",KZ:"Kazakhstan",LA:"Laos",LB:"Lebanon",LC:"Saint Lucia",LI:"Liechtenstein",LK:"Sri Lanka",LR:"Liberia",LS:"Lesotho",LT:"Lithuania",LU:"Luxembourg",LV:"Latvia",LY:"Libya",MA:"Morocco",MC:"Monaco",MD:"Moldova",ME:"Montenegro",MF:"Saint Martin",MG:"Madagascar",MH:"Marshall Islands",MK:"North Macedonia",ML:"Mali",MM:"Myanmar",MN:"Mongolia",MO:"Macau",MP:"Northern Mariana Islands",MQ:"Martinique",MR:"Mauritania",MS:"Montserrat",MT:"Malta",MU:"Mauritius",MV:"Maldives",MW:"Malawi",MX:"Mexico",MY:"Malaysia",MZ:"Mozambique",NA:"Namibia",NC:"New Caledonia",NE:"Niger",NF:"Norfolk Island",NG:"Nigeria",NI:"Nicaragua",NL:"Netherlands",NO:"Norway",NP:"Nepal",NR:"Nauru",NU:"Niue",NZ:"New Zealand",OM:"Oman",PA:"Panama",PE:"Peru",PF:"French Polynesia",PG:"Papua New Guinea",PH:"Philippines",PK:"Pakistan",PL:"Poland",PM:"Saint Pierre and Miquelon",PN:"Pitcairn",PR:"Puerto Rico",PS:"Palestine",PT:"Portugal",PW:"Palau",PY:"Paraguay",QA:"Qatar",RE:"Réunion",RO:"Romania",RS:"Serbia",RU:"Russia",RW:"Rwanda",SA:"Saudi Arabia",SB:"Solomon Islands",SC:"Seychelles",SD:"Sudan",SE:"Sweden",SG:"Singapore",SH:"Saint Helena",SI:"Slovenia",SJ:"Svalbard and Jan Mayen",SK:"Slovakia",SL:"Sierra Leone",SM:"San Marino",SN:"Senegal",SO:"Somalia",SR:"Suriname",SS:"South Sudan",ST:"São Tomé and Príncipe",SV:"El Salvador",SX:"Sint Maarten",SY:"Syria",SZ:"Eswatini",TC:"Turks and Caicos Islands",TD:"Chad",TF:"French Southern Territories",TG:"Togo",TH:"Thailand",TJ:"Tajikistan",TK:"Tokelau",TL:"Timor-Leste",TM:"Turkmenistan",TN:"Tunisia",TO:"Tonga",TR:"Turkey",TT:"Trinidad and Tobago",TV:"Tuvalu",TW:"Taiwan",TZ:"Tanzania",UA:"Ukraine",UG:"Uganda",UM:"U.S. Minor Outlying Islands",US:"United States",UY:"Uruguay",UZ:"Uzbekistan",VA:"Vatican City",VC:"Saint Vincent and the Grenadines",VE:"Venezuela",VG:"British Virgin Islands",VI:"U.S. Virgin Islands",VN:"Vietnam",VU:"Vanuatu",WF:"Wallis and Futuna",WS:"Samoa",XK:"Kosovo",YE:"Yemen",YT:"Mayotte",ZA:"South Africa",ZM:"Zambia",ZW:"Zimbabwe"
};

function loadCategories() {
  const raw = fs.readFileSync(CATEGORIES_CSV, "utf8").split(/\r?\n/);
  raw.shift();
  const set = new Set();
  for (let line of raw) {
    let name = line.replace(/^\uFEFF/, "").trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    if (name) set.add(name);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function buildLocations() {
  fs.mkdirSync(LOC_DIR, { recursive: true });
  const raw = fs.readFileSync(GEONAMES_CSV, "utf8").split(/\r?\n/);
  raw.shift();
  // country code -> { admin1code -> { name, cities: Map(city -> Set(zip)) } }
  const countries = new Map();
  for (const line of raw) {
    if (!line) continue;
    const f = line.split(";");
    const cc = f[0];
    if (!cc || cc.length !== 2) continue;
    const zip = (f[1] || "").trim();
    const place = (f[2] || "").trim();
    const a1name = (f[3] || "").trim();
    const a1code = (f[4] || "").trim() || "_";
    if (!place) continue;
    if (!countries.has(cc)) countries.set(cc, new Map());
    const admins = countries.get(cc);
    if (!admins.has(a1code)) admins.set(a1code, { name: a1name || a1code, cities: new Map() });
    const adm = admins.get(a1code);
    if (a1name && adm.name === a1code) adm.name = a1name;
    if (!adm.cities.has(place)) adm.cities.set(place, new Set());
    for (const z of zip.split(/\s+/)) if (z) adm.cities.get(place).add(z);
  }

  const index = [];
  for (const [cc, admins] of countries) {
    let cityCount = 0, zipCount = 0;
    const a = [...admins.entries()]
      .sort((x, y) => x[1].name.localeCompare(y[1].name))
      .map(([code, adm]) => {
        const ct = [...adm.cities.entries()]
          .sort((x, y) => x[0].localeCompare(y[0]))
          .map(([city, zips]) => {
            cityCount++; zipCount += zips.size;
            return [city, [...zips].sort()];
          });
        return { n: adm.name, c: code, ct };
      });
    const doc = { c: cc, n: ISO[cc] || cc, a };
    fs.writeFileSync(path.join(LOC_DIR, cc + ".json"), JSON.stringify(doc));
    index.push({ c: cc, n: ISO[cc] || cc, cities: cityCount, zips: zipCount });
  }
  index.sort((a, b) => a.n.localeCompare(b.n));
  fs.writeFileSync(path.join(OUT_DIR, "countries.json"), JSON.stringify(index));
  return index;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const categories = loadCategories();
fs.writeFileSync(path.join(OUT_DIR, "categories.json"), JSON.stringify(categories));
const index = buildLocations();

function dirSize(d) {
  let t = 0;
  for (const f of fs.readdirSync(d)) {
    const s = fs.statSync(path.join(d, f));
    t += s.isDirectory() ? dirSize(path.join(d, f)) : s.size;
  }
  return t;
}
console.log("categories.json:", categories.length, "categories");
console.log("countries      :", index.length);
console.log("total cities   :", index.reduce((a, c) => a + c.cities, 0).toLocaleString());
console.log("total zips     :", index.reduce((a, c) => a + c.zips, 0).toLocaleString());
console.log("data dir size  :", (dirSize(OUT_DIR) / 1024 / 1024).toFixed(1) + " MB");
console.log("biggest loc files:");
fs.readdirSync(LOC_DIR).map(f => [f, fs.statSync(path.join(LOC_DIR, f)).size])
  .sort((a, b) => b[1] - a[1]).slice(0, 6)
  .forEach(([f, s]) => console.log("   ", f, (s / 1024 / 1024).toFixed(1) + "MB"));
