import test from 'node:test';
import assert from 'node:assert/strict';
import { outfitFor, splitFeeling, OUTFITS, FEELINGS } from '../src/wardrobe.mjs';

const at = (iso, timezone = 'Europe/Paris', outfit = 'auto') => outfitFor({ timezone, outfit }, new Date(iso));

test('special days, night and evening pick the outfit in the owner\'s timezone', () => {
  assert.equal(at('2026-10-31T10:00:00Z'), 'halloween');
  assert.equal(at('2026-12-24T15:00:00Z'), 'christmas');
  assert.equal(at('2026-12-31T21:30:00Z'), 'party', 'New Year\'s Eve party goes on past 10 pm');
  assert.equal(at('2026-12-31T23:30:00Z'), 'party', 'still the party just after midnight in Paris');
  assert.equal(at('2027-01-01T11:00:00Z'), 'new-year');
  assert.equal(at('2027-02-06T12:00:00Z'), 'lunar-new-year');
  assert.equal(at('2027-02-14T12:00:00Z'), 'valentine');
  assert.equal(at('2027-03-28T12:00:00Z'), 'easter', 'Easter Sunday 2027');
  assert.equal(at('2027-03-29T12:00:00Z'), 'easter', 'Easter Monday');
  assert.equal(at('2027-07-14T12:00:00Z'), 'summer-festival');
  assert.equal(at('2026-10-31T02:00:00Z'), 'pajamas', 'special days wait until morning');
  assert.equal(at('2026-11-03T22:30:00Z'), 'pajamas');
  assert.equal(at('2026-11-03T18:30:00Z'), 'cozy-home', '7:30 pm in Paris');
  assert.equal(at('2026-11-03T18:30:00Z', 'UTC') !== 'cozy-home', true, 'the timezone matters');
});

test('days follow the season, a pinned outfit always wins', () => {
  const day = iso => at(iso);
  assert.ok(['base', 'autumn', 'windy'].includes(day('2026-11-03T10:00:00Z')));
  assert.ok(['base', 'winter'].includes(day('2027-01-20T10:00:00Z')));
  assert.ok(['base', 'spring'].includes(day('2027-04-20T10:00:00Z')));
  assert.ok(['base', 'summer', 'sunny'].includes(day('2027-08-01T10:00:00Z')));
  const days = new Set(Array.from({ length: 10 }, (_, i) => day(`2026-11-${String(i + 3).padStart(2, '0')}T10:00:00Z`)));
  assert.ok(days.size > 1, 'the outfit changes from day to day');
  assert.equal(day('2026-11-03T10:00:00Z'), day('2026-11-03T15:00:00Z'), 'and stays the same all day');
  assert.equal(at('2026-10-31T10:00:00Z', 'Europe/Paris', 'rain'), 'rain');
  assert.equal(at('2026-10-31T10:00:00Z', 'Not/AZone'), 'halloween');
  for (const id of ['halloween', 'pajamas', 'cozy-home']) assert.ok(OUTFITS[id].wears.length > 10);
});

test('the feeling tag is split off, also while it is still arriving', () => {
  assert.deepEqual(splitFeeling('[feeling:laugh] Ha!'), { text: 'Ha!', feeling: 'laugh', pending: false });
  assert.deepEqual(splitFeeling('  [Feeling: Tender]\nHey you'), { text: 'Hey you', feeling: 'tender', pending: false });
  for (const partial of ['[', '[feel', '[feeling:', '[feeling:la']) assert.equal(splitFeeling(partial).pending, true, partial);
  assert.deepEqual(splitFeeling('Sure! [feeling:wink]'), { text: 'Sure!', feeling: 'wink', pending: false });
  assert.deepEqual(splitFeeling('[feeling:angry] Hmph'), { text: 'Hmph', feeling: null, pending: false }, 'unknown feelings are dropped');
  assert.deepEqual(splitFeeling('[link] text'), { text: '[link] text', feeling: null, pending: false });
  assert.deepEqual(splitFeeling('Plain reply'), { text: 'Plain reply', feeling: null, pending: false });
  assert.ok(FEELINGS.includes('laugh') && !FEELINGS.includes('talk'));
});
