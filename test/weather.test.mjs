import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapStore } from '../src/store.mjs';
import { Weather, WeatherError, weatherOutfit, describeWeather } from '../src/weather.mjs';
import { outfitFor } from '../src/wardrobe.mjs';
import { instructions } from '../src/companion.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = '6f1c1b2e-1d2a-4c3b-9a8b-7c6d5e4f3a2b';

function fakeOpenMeteo({ places = { lyon: { name: 'Lyon', admin1: 'Auvergne-Rhône-Alpes', country: 'France', latitude: 45.75, longitude: 4.85 } },
  current = { temperature_2m: 8.2, weather_code: 61, wind_speed_10m: 11.6, is_day: 1 }, failForecast = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push(parsed);
    assert.equal(options.redirect, 'error');
    if (parsed.hostname === 'geocoding-api.open-meteo.com') {
      const found = places[parsed.searchParams.get('name').toLowerCase()];
      return Response.json(found ? { results: [found] } : {});
    }
    if (parsed.hostname === 'api.open-meteo.com') {
      if (failForecast) return new Response('down', { status: 503 });
      return Response.json({ current: { time: '2026-11-03T07:30', ...current } });
    }
    throw new Error('unexpected host ' + parsed.hostname);
  };
  return { fetchImpl, calls };
}

function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), 'weather-')), store = new BootstrapStore(dir, ROOT);
  let clock = Date.UTC(2026, 10, 3, 10);
  const fake = fakeOpenMeteo(options);
  const weather = new Weather({ store, fetchImpl: fake.fetchImpl, now: () => clock });
  t.after(() => { weather.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { weather, fake, advance: ms => { clock += ms; } };
}

test('setting a city looks it up, stores the place and reads the weather right away', async t => {
  const { weather, fake } = fixture(t);
  const snapshot = await weather.setPlace(ID, '  Lyon ');
  assert.equal(snapshot.place, 'Lyon, Auvergne-Rhône-Alpes, France');
  assert.deepEqual(snapshot.current, { code: 61, temperature: 8.2, wind: 11.6, day: true, summary: 'light rain, 8°C, wind 12 km/h' });
  const forecast = fake.calls.find(url => url.hostname === 'api.open-meteo.com');
  assert.equal(forecast.searchParams.get('latitude'), '45.75');
  assert.ok(!fake.calls.some(url => url.search.includes(ID)), 'Nothing identifying the owner is sent');
});

test('an unknown city is refused and nothing is saved; an empty name clears the place', async t => {
  const { weather } = fixture(t);
  await assert.rejects(weather.setPlace(ID, 'Nowhereville'), error => error instanceof WeatherError && error.code === 'PLACE_NOT_FOUND');
  assert.deepEqual(weather.snapshot(ID), { place: null });
  await weather.setPlace(ID, 'Lyon');
  assert.deepEqual(await weather.setPlace(ID, ''), { place: null });
  assert.equal(weather.current(ID), null);
  await assert.rejects(weather.setPlace(ID, 'x'.repeat(101)), { code: 'INVALID_REQUEST' });
});

test('old readings expire and the hourly tick refreshes them; a failing service keeps the place', async t => {
  const { weather, advance } = fixture(t);
  await weather.setPlace(ID, 'Lyon');
  advance(4 * 3600_000);
  assert.equal(weather.current(ID), null, 'A reading older than three hours is not trusted');
  await weather.tick();
  assert.equal(weather.current(ID).code, 61);
  const down = fixture(t, { failForecast: true });
  const snapshot = await down.weather.setPlace(ID, 'Lyon');
  assert.equal(snapshot.place, 'Lyon, Auvergne-Rhône-Alpes, France');
  assert.equal(snapshot.current, undefined);
});

test('the weather picks the daytime outfit; night, evening, special days and a pinned outfit still win', () => {
  const profile = { timezone: 'Europe/Paris', outfit: 'auto' };
  const rain = { code: 63, temperature: 9, wind: 10 }, noon = new Date('2026-11-03T11:00:00Z');
  assert.equal(outfitFor(profile, noon, rain), 'rain');
  assert.equal(outfitFor(profile, new Date('2026-11-03T22:30:00Z'), rain), 'pajamas');
  assert.equal(outfitFor(profile, new Date('2026-11-03T19:00:00Z'), rain), 'cozy-home');
  assert.equal(outfitFor(profile, new Date('2026-10-31T11:00:00Z'), rain), 'halloween');
  assert.equal(outfitFor({ ...profile, outfit: 'spring' }, noon, rain), 'spring');
  assert.equal(outfitFor(profile, noon, null), outfitFor(profile, noon), 'Without weather the season decides');
});

test('weather codes, cold, heat and wind map to outfits', () => {
  assert.equal(weatherOutfit({ code: 73, temperature: -2, wind: 5 }), 'snow');
  assert.equal(weatherOutfit({ code: 95, temperature: 20, wind: 5 }), 'rain');
  assert.equal(weatherOutfit({ code: 3, temperature: 12, wind: 45 }), 'windy');
  assert.equal(weatherOutfit({ code: 2, temperature: 1, wind: 5 }), 'winter');
  assert.equal(weatherOutfit({ code: 2, temperature: 30, wind: 5 }), 'summer');
  assert.equal(weatherOutfit({ code: 0, temperature: 22, wind: 5 }), 'sunny');
  assert.equal(weatherOutfit({ code: 3, temperature: 14, wind: 10 }), null);
  assert.equal(describeWeather({ code: 3, temperature: 14.4, wind: 9.6 }), 'overcast, 14°C, wind 10 km/h');
});

test('the companion is told the weather where its owner is', () => {
  const text = instructions({ owner: { name: 'Blackout', provider: 'codex' }, profile: { name: 'Claude', character: 'claude', color: 'peach', timezone: 'Europe/Paris', outfit: 'auto' },
    dir: '/tmp/x', now: new Date('2026-11-03T11:00:00Z'), files: false,
    weather: { place: 'Lyon, France', current: { code: 61, temperature: 8.2, wind: 11.6, day: true } } });
  assert.match(text, /Weather where Blackout is \(Lyon, France\): light rain, 8°C, wind 12 km\/h\./);
  assert.match(text, /glossy yellow raincoat/);
  const none = instructions({ owner: { name: 'Blackout', provider: 'codex' }, profile: null, dir: '/tmp/x', files: false });
  assert.doesNotMatch(none, /Weather where/);
});

test('owners set and read their place through the companion endpoint; the outfit follows', async t => {
  const { createCompanionHttp } = await import('../src/companion-http.mjs');
  const { weather } = fixture(t, { current: { temperature_2m: -3, weather_code: 73, wind_speed_10m: 5, is_day: 1 } });
  const profile = { name: 'Claude', character: 'claude', color: 'peach', timezone: 'Europe/Paris', outfit: 'auto' };
  const http = createCompanionHttp({ access: { read: async request => ({ value: request }), authorize: async () => ({ companionId: ID }) },
    profiles: { get: () => profile }, workspaceFor: () => null, runtimeStatus: async () => ({ state: 'ready' }),
    now: () => new Date('2026-11-03T11:00:00Z'), weather });
  const saved = await http({ action: 'setWeatherPlace', place: 'Lyon' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.place, 'Lyon, Auvergne-Rhône-Alpes, France');
  assert.equal(saved.body.wearing, 'snow');
  assert.equal((await http({ action: 'get' })).body.wearing, 'snow');
  assert.equal((await http({ action: 'weather' })).body.current.summary, 'snow, -3°C, wind 5 km/h');
  const missing = await http({ action: 'setWeatherPlace', place: 'Nowhereville' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PLACE_NOT_FOUND');
  assert.equal((await http({ action: 'setWeatherPlace', place: 'Lyon', extra: 1 })).status, 400);
});
