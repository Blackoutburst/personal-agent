// The owner's city for local weather (src/weather.mjs): the outfit and the companion follow it.
export function createWeatherUI({ document, api, onDenied = () => {}, onWearing = () => {} }) {
  const $ = id => document.getElementById(id);
  let epoch = 0, busy = false;
  function show(snapshot, notice = '') {
    $('weather-place').value = snapshot?.place ?? '';
    $('weather-now').textContent = notice || (snapshot?.place
      ? (snapshot.current ? `Now in ${snapshot.place}: ${snapshot.current.summary}.` : `Saved: ${snapshot.place}. The weather will show up shortly.`)
      : 'No city set. The outfit follows the seasons only.');
  }
  function failed(error, fallback) {
    if (error.status === 401 || error.status === 403) { clear(); onDenied(); return; }
    $('weather-now').textContent = error.message === 'PLACE_NOT_FOUND' ? 'That place was not found. Try a nearby city.' : fallback;
  }
  async function load() {
    const mine = ++epoch;
    try { const snapshot = await api({ action: 'weather' }); if (mine === epoch) show(snapshot); }
    catch (error) { if (mine === epoch) failed(error, 'The weather could not be loaded.'); }
  }
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const mine = ++epoch, place = $('weather-place').value.trim().slice(0, 100);
    busy = true; $('weather-save').disabled = true; $('weather-now').textContent = place ? 'Looking it up…' : 'Removing your city…';
    try {
      const result = await api({ action: 'setWeatherPlace', place });
      if (mine !== epoch) return;
      show(result); if (typeof result.wearing === 'string') onWearing(result.wearing);
    } catch (error) { if (mine === epoch) failed(error, 'The weather service is unavailable right now. Try again later.'); }
    finally { busy = false; $('weather-save').disabled = false; }
  }
  function clear() { epoch++; busy = false; $('weather-place').value = ''; $('weather-now').textContent = ''; $('weather-save').disabled = false; }
  $('weather-form').addEventListener('submit', save);
  return { load, clear };
}
