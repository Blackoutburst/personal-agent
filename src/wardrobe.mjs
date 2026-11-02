// Claude-chan's wardrobe and faces: which outfit she wears now, and the feeling tag that picks her face.
// The pictures are in public/characters/claude (docs/COMPANION.md).

export const OUTFITS = Object.freeze({
  base: { label: 'Signature blouse', wears: 'your signature cream ruffled blouse with the black bow and flower brooch' },
  'cozy-home': { label: 'Cozy at home', wears: 'a soft oversized cream knit cardigan over an orange top, cozy for the evening' },
  pajamas: { label: 'Pajamas', wears: 'pastel orange pajamas with a little flower print and a sleeping cap with a pompom' },
  rain: { label: 'Rain', wears: 'a glossy yellow raincoat with the hood down' },
  sunny: { label: 'Sunny day', wears: 'a light white sundress and a wide straw hat with an orange ribbon' },
  snow: { label: 'Snow', wears: 'a puffy winter coat, a chunky orange scarf and fluffy earmuffs' },
  windy: { label: 'Windy day', wears: 'a beige trench coat with the collar up' },
  spring: { label: 'Spring', wears: 'a pastel peach dress with a white collar and a cherry-blossom pin' },
  summer: { label: 'Summer', wears: 'a light white-and-orange sailor top' },
  autumn: { label: 'Autumn', wears: 'a warm brown knit sweater, a burgundy beret and a maple-leaf pin' },
  winter: { label: 'Winter', wears: 'a cream turtleneck sweater and a cozy orange scarf' },
  halloween: { label: 'Halloween', wears: 'a cute witch outfit: a pointed witch hat with your flower on the band, a black cape and a pumpkin brooch' },
  christmas: { label: 'Christmas', wears: 'a red Santa dress with white fluffy trim and a Santa hat' },
  party: { label: "New Year's Eve", wears: 'a sparkly golden party dress with a star hairclip' },
  'new-year': { label: 'New Year', wears: 'an orange-and-cream furisode kimono with an obi and a kanzashi in your hair' },
  'lunar-new-year': { label: 'Lunar New Year', wears: 'a red qipao with gold embroidery and a gold tassel hairpin' },
  valentine: { label: "Valentine's Day", wears: 'a soft pink dress with a heart brooch and a heart hairclip' },
  easter: { label: 'Easter', wears: 'a pastel outfit with a fluffy white bunny-ears headband' },
  'summer-festival': { label: 'Summer festival', wears: 'a light orange yukata with a goldfish pattern and a fireworks hairpin' },
  birthday: { label: 'Birthday', wears: 'a festive dress and a little striped party hat' }
});

// Faces the companion can choose for a reply ([feeling:<name>] at its start).
export const FEELINGS = Object.freeze(['happy', 'laugh', 'wink', 'surprised', 'sad', 'worried', 'teary-smile', 'embarrassed', 'pout',
  'proud', 'excited', 'confused', 'determined', 'tender', 'love', 'focused', 'thinking', 'sleepy']);

// Lunar New Year (first day), as month-day per year.
const LUNAR_NEW_YEAR = { 2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03', 2031: '01-23', 2032: '02-11',
  2033: '01-31', 2034: '02-19', 2035: '02-08' };

function easter(year) { // Anonymous Gregorian computus
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

function localParts(now, timezone) {
  let zone = timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(part => [part.type, part.value]));
  return { year: Number(parts.year), md: `${parts.month}-${parts.day}`, hour: Number(parts.hour),
    utcDay: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) };
}

function specialDay({ year, md, hour, utcDay }) {
  if (md === '12-31' || (md === '01-01' && hour < 3)) return 'party';
  if (md === '01-01' || md === '01-02') return 'new-year';
  if (LUNAR_NEW_YEAR[year] === md) return 'lunar-new-year';
  if (md === '02-14') return 'valentine';
  const days = (utcDay - easter(year)) / 86400000;
  if (days === 0 || days === 1) return 'easter';
  if (md === '07-14') return 'summer-festival'; // fireworks night
  if (md === '10-31') return 'halloween';
  if (md === '12-24' || md === '12-25') return 'christmas';
  return null;
}

function season(md) {
  if (md >= '03-20' && md < '06-21') return ['base', 'spring'];
  if (md >= '06-21' && md < '09-23') return ['base', 'summer', 'sunny'];
  if (md >= '09-23' && md < '12-21') return ['base', 'autumn', 'windy'];
  return ['base', 'winter'];
}

// What she wears now: the pinned outfit, else special days (all day, pajamas after 1 am), pajamas at night,
// the cardigan in the evening, and during the day an outfit of the season that changes each day.
export function outfitFor(profile, now = new Date()) {
  if (profile?.outfit && profile.outfit !== 'auto' && OUTFITS[profile.outfit]) return profile.outfit;
  const local = localParts(now, profile?.timezone ?? 'UTC');
  const special = specialDay(local);
  if (special && (special === 'party' || local.hour >= 7)) return special;
  if (local.hour >= 22 || local.hour < 7) return 'pajamas';
  if (local.hour >= 19) return 'cozy-home';
  const choices = season(local.md), day = Math.floor(local.utcDay / 86400000);
  return choices[(day * 7 + 3) % choices.length];
}

const MARK = /^\s*\[feeling:\s*([a-z-]{1,20})\s*\]\s*/i, TRAILING = /\s*\[feeling:\s*([a-z-]{1,20})\s*\]\s*$/i;
const PREFIX = '[feeling:';

// Splits the feeling tag off a (possibly partial, still streaming) reply. While the reply could still be
// the start of a tag, the text is held back (pending) so the tag never shows.
export function splitFeeling(raw) {
  const head = raw.replace(/^\s+/, '');
  if (head.length < 40 && !head.includes(']') && (PREFIX.startsWith(head.toLowerCase()) || head.toLowerCase().startsWith(PREFIX))) {
    return { text: '', feeling: null, pending: true };
  }
  let text = raw, feeling = null;
  const lead = text.match(MARK);
  if (lead) { text = text.slice(lead[0].length); feeling = lead[1].toLowerCase(); }
  const tail = text.match(TRAILING);
  if (tail) { text = text.slice(0, tail.index); feeling ??= tail[1].toLowerCase(); }
  return { text, feeling: FEELINGS.includes(feeling) ? feeling : null, pending: false };
}
