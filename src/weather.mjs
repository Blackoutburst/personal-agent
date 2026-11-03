// Local weather for each companion's owner (docs/COMPANION.md): the owner types a city once, the server
// looks it up with Open-Meteo (free, no key) and refreshes the current weather about once an hour.
// Only the city name (on lookup) and its coordinates are ever sent to Open-Meteo.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const REFRESH_MS = 55 * 60_000, STALE_MS = 3 * 3600_000, TICK_MS = 5 * 60_000, TIMEOUT_MS = 10_000;

export class WeatherError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

// WMO weather codes (Open-Meteo docs) to short words.
const CODES = [
  [[0], 'clear sky'], [[1], 'mostly clear'], [[2], 'partly cloudy'], [[3], 'overcast'], [[45, 48], 'fog'],
  [[51, 53, 55], 'drizzle'], [[56, 57], 'freezing drizzle'], [[61], 'light rain'], [[63], 'rain'], [[65], 'heavy rain'],
  [[66, 67], 'freezing rain'], [[71], 'light snow'], [[73], 'snow'], [[75], 'heavy snow'], [[77], 'snow grains'],
  [[80, 81], 'rain showers'], [[82], 'heavy rain showers'], [[85, 86], 'snow showers'], [[95], 'thunderstorm'], [[96, 99], 'thunderstorm with hail']
];
const words = code => CODES.find(([codes]) => codes.includes(code))?.[1] ?? 'unknown weather';
const RAIN = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);

// The outfit the weather calls for during the day, or null to keep the season's choice.
export function weatherOutfit(current) {
  if (!current) return null;
  const { code, temperature, wind } = current;
  if (SNOW.has(code)) return 'snow';
  if (RAIN.has(code)) return 'rain';
  if (wind >= 40) return 'windy';
  if (temperature <= 2) return 'winter';
  if (temperature >= 27) return 'summer';
  if (code <= 1 && temperature >= 20) return 'sunny';
  return null;
}

export function describeWeather(current) {
  if (!current) return null;
  return `${words(current.code)}, ${Math.round(current.temperature)}°C, wind ${Math.round(current.wind)} km/h`;
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
}

export class Weather {
  #db; #fetch; #now; #timer = null; #running = false;
  constructor({ store, fetchImpl = fetch, now = Date.now }) {
    this.#db = store.db; this.#fetch = fetchImpl; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS companion_weather (
      companion_id TEXT PRIMARY KEY, place TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
      current_json TEXT, fetched_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  }

  #row(companionId) { return this.#db.prepare('SELECT * FROM companion_weather WHERE companion_id=?').get(companionId) ?? null; }

  // The current weather if it is recent enough to trust, else null.
  current(companionId) {
    const row = this.#row(companionId);
    if (!row?.current_json || this.#now() - row.fetched_at > STALE_MS) return null;
    try { return JSON.parse(row.current_json); } catch { return null; }
  }

  // What the owner sees: their place and the latest reading.
  snapshot(companionId) {
    const row = this.#row(companionId);
    if (!row) return { place: null };
    const current = this.current(companionId);
    return { place: row.place, ...(current ? { current: { ...current, summary: describeWeather(current) },
      fetchedAtISO: new Date(row.fetched_at).toISOString() } : {}) };
  }

  async #json(url) {
    const response = await this.#fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'blackoutburst-companion/1' },
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new WeatherError('WEATHER_UNAVAILABLE', 503);
    const text = await response.text();
    if (text.length > 200_000) throw new WeatherError('WEATHER_UNAVAILABLE', 503);
    return JSON.parse(text);
  }

  // Set (or clear, with an empty name) the owner's place. Looks the city up first.
  async setPlace(companionId, name) {
    if (typeof name !== 'string' || name.length > 100) throw new WeatherError('INVALID_REQUEST');
    const query = name.trim();
    if (!query) { this.#db.prepare('DELETE FROM companion_weather WHERE companion_id=?').run(companionId); return this.snapshot(companionId); }
    let found;
    try {
      const data = await this.#json(`${GEOCODE}?${new URLSearchParams({ name: query, count: '1', language: 'en', format: 'json' })}`);
      found = data?.results?.[0];
    } catch (error) { throw error instanceof WeatherError ? error : new WeatherError('WEATHER_UNAVAILABLE', 503); }
    if (!found || !finite(found.latitude) || !finite(found.longitude)) throw new WeatherError('PLACE_NOT_FOUND', 404);
    const place = [cleanText(found.name, 60), cleanText(found.admin1, 60), cleanText(found.country, 60)]
      .filter((part, index, all) => part && all.indexOf(part) === index).join(', ') || query.slice(0, 60);
    this.#db.prepare(`INSERT INTO companion_weather (companion_id, place, latitude, longitude, current_json, fetched_at, updated_at)
      VALUES (?,?,?,?,NULL,0,?) ON CONFLICT(companion_id) DO UPDATE SET place=excluded.place, latitude=excluded.latitude,
      longitude=excluded.longitude, current_json=NULL, fetched_at=0, updated_at=excluded.updated_at`)
      .run(companionId, place, found.latitude, found.longitude, this.#now());
    try { await this.refresh(companionId); } catch { /* the place is saved; the next tick tries again */ }
    return this.snapshot(companionId);
  }

  async refresh(companionId) {
    const row = this.#row(companionId);
    if (!row) return null;
    const data = await this.#json(`${FORECAST}?${new URLSearchParams({ latitude: String(row.latitude), longitude: String(row.longitude),
      current: 'temperature_2m,weather_code,wind_speed_10m,is_day', wind_speed_unit: 'kmh', timezone: 'GMT' })}`);
    const c = data?.current;
    if (!c || !finite(c.temperature_2m) || !Number.isInteger(c.weather_code) || !finite(c.wind_speed_10m)) throw new WeatherError('WEATHER_UNAVAILABLE', 503);
    const current = { code: c.weather_code, temperature: c.temperature_2m, wind: c.wind_speed_10m, day: c.is_day === 1 };
    // Only store it if the place did not change while the request was out.
    this.#db.prepare('UPDATE companion_weather SET current_json=?, fetched_at=? WHERE companion_id=? AND latitude=? AND longitude=?')
      .run(JSON.stringify(current), this.#now(), companionId, row.latitude, row.longitude);
    return current;
  }

  // One pass: refresh every place older than REFRESH_MS, one at a time.
  async tick() {
    if (this.#running) return;
    this.#running = true;
    try {
      const due = this.#db.prepare('SELECT companion_id FROM companion_weather WHERE fetched_at < ?').all(this.#now() - REFRESH_MS);
      for (const { companion_id: id } of due) {
        try { await this.refresh(id); } catch { /* try again next tick; old readings expire after STALE_MS */ }
      }
    } finally { this.#running = false; }
  }

  start() {
    if (this.#timer) return;
    this.tick().catch(() => {});
    this.#timer = setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.#timer.unref?.();
  }
  stop() { clearInterval(this.#timer); this.#timer = null; }
}
