// Illustrated companion characters as SVG, with expressions.
// renderCharacter({character, color, mood}) returns SVG markup (static, no script).

export const CHARACTERS = [
  { id: 'pip', label: 'Pip', hint: 'a round little blob' },
  { id: 'mochi', label: 'Mochi', hint: 'a soft cat' },
  { id: 'sprout', label: 'Sprout', hint: 'a tiny plant spirit' },
  { id: 'luna', label: 'Luna', hint: 'a friendly ghost' },
  { id: 'claude', label: 'Claude', hint: 'a cheerful anime girl' }
];
export const COLORS = {
  peach: { body: '#FFB38A', shade: '#EE8F64', light: '#FFDCC8', cheek: '#FF7E7E' },
  mint: { body: '#8EDCB8', shade: '#5CC291', light: '#D2F5E5', cheek: '#FF8E9A' },
  sky: { body: '#93CBF6', shade: '#5EAAE6', light: '#D3EAFC', cheek: '#FF92AE' },
  lilac: { body: '#C7ABF4', shade: '#A07FE0', light: '#E9DDFC', cheek: '#FF8FBF' },
  sun: { body: '#FFD772', shade: '#F1B83A', light: '#FFF0C2', cheek: '#FF9472' },
  rose: { body: '#F8A6C4', shade: '#E87BA3', light: '#FDD8E6', cheek: '#FF6F96' }
};
export const MOODS = ['idle', 'listening', 'thinking', 'talking', 'happy', 'sleepy'];
const INK = '#3A2E39';

// Body shapes in a 200×200 box; face is the vertical position of the eyes.
const BODIES = {
  pip: { face: 106, shadow: 52, draw: c => `
    <path d="M100 40 C 98 30 102 22 110 16" fill="none" stroke="${c.shade}" stroke-width="4.5" stroke-linecap="round"/>
    <circle cx="111" cy="14" r="7.5" fill="${c.shade}"/>
    <ellipse cx="78" cy="176" rx="15" ry="7.5" fill="${c.shade}"/><ellipse cx="122" cy="176" rx="15" ry="7.5" fill="${c.shade}"/>
    <ellipse cx="35" cy="128" rx="9" ry="14" fill="${c.shade}" transform="rotate(18 35 128)"/>
    <ellipse cx="165" cy="128" rx="9" ry="14" fill="${c.shade}" transform="rotate(-18 165 128)"/>
    <path d="M100 40 C 148 40 168 80 166 118 C 164 158 136 176 100 176 C 64 176 36 158 34 118 C 32 80 52 40 100 40 Z" fill="${c.body}"/>
    <ellipse cx="100" cy="146" rx="36" ry="22" fill="${c.light}" opacity=".7"/>
    <ellipse cx="72" cy="66" rx="14" ry="8" fill="#fff" opacity=".35" transform="rotate(-25 72 66)"/>` },
  mochi: { face: 106, shadow: 54, draw: c => `
    <path d="M150 160 C 186 160 194 124 176 106" fill="none" stroke="${c.shade}" stroke-width="13" stroke-linecap="round"/>
    <ellipse cx="78" cy="177" rx="15" ry="7" fill="${c.shade}"/><ellipse cx="122" cy="177" rx="15" ry="7" fill="${c.shade}"/>
    <path d="M54 72 L 46 30 L 84 52 Q 100 47 116 52 L 154 30 L 146 72 Q 170 100 164 138 Q 156 178 100 178 Q 44 178 36 138 Q 30 100 54 72 Z" fill="${c.body}" stroke="${c.body}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M58 62 L 54 40 L 76 54 Z" fill="${c.cheek}" opacity=".45"/><path d="M142 62 L 146 40 L 124 54 Z" fill="${c.cheek}" opacity=".45"/>
    <ellipse cx="100" cy="150" rx="34" ry="20" fill="${c.light}" opacity=".75"/>
    <g stroke="${c.shade}" stroke-width="2.5" stroke-linecap="round"><path d="M54 116 L 32 110"/><path d="M54 123 L 32 127"/><path d="M146 116 L 168 110"/><path d="M146 123 L 168 127"/></g>
    <ellipse cx="100" cy="116" rx="4" ry="3" fill="${c.cheek}"/>` },
  sprout: { face: 120, shadow: 52, draw: c => `
    <path d="M100 56 C 100 46 100 40 101 30" fill="none" stroke="#5AAE62" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M100 38 C 84 22 64 26 60 36 C 74 46 90 46 100 38 Z" fill="#7BC67E"/>
    <path d="M101 33 C 116 12 142 14 147 27 C 133 41 114 41 101 33 Z" fill="#8FD48F"/>
    <ellipse cx="78" cy="178" rx="15" ry="7" fill="${c.shade}"/><ellipse cx="122" cy="178" rx="15" ry="7" fill="${c.shade}"/>
    <path d="M100 52 C 140 52 168 92 166 128 C 164 162 136 178 100 178 C 64 178 36 162 34 128 C 32 92 60 52 100 52 Z" fill="${c.body}"/>
    <ellipse cx="100" cy="155" rx="34" ry="17" fill="${c.light}" opacity=".7"/>
    <ellipse cx="70" cy="80" rx="12" ry="7" fill="#fff" opacity=".35" transform="rotate(-35 70 80)"/>` },
  luna: { face: 102, shadow: 40, draw: c => `
    <ellipse cx="33" cy="118" rx="9" ry="15" fill="${c.shade}" transform="rotate(25 33 118)"/>
    <ellipse cx="167" cy="118" rx="9" ry="15" fill="${c.shade}" transform="rotate(-25 167 118)"/>
    <path d="M100 38 C 146 38 166 74 166 112 L 166 158 Q 155 176 144 160 Q 133 176 122 160 Q 111 176 100 160 Q 89 176 78 160 Q 67 176 56 160 Q 45 176 34 158 L 34 112 C 34 74 54 38 100 38 Z" fill="${c.body}"/>
    <ellipse cx="100" cy="138" rx="34" ry="18" fill="${c.light}" opacity=".6"/>
    <path d="M66 52 L 69 60 L 77 63 L 69 66 L 66 74 L 63 66 L 55 63 L 63 60 Z" fill="#fff" opacity=".8"/>` }
};

function eyes(y, mood) {
  const at = [78, 122];
  if (mood === 'happy') return at.map(x => `<path d="M${x - 8} ${y + 3} Q ${x} ${y - 9} ${x + 8} ${y + 3}" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`).join('');
  if (mood === 'sleepy') return at.map(x => `<path d="M${x - 8} ${y} Q ${x} ${y + 7} ${x + 8} ${y}" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`).join('');
  const dy = mood === 'thinking' ? -3 : mood === 'listening' ? 3 : 0, dx = mood === 'thinking' ? 3 : 0;
  return `<g class="char-eyes">${at.map(x => `<ellipse cx="${x}" cy="${y}" rx="8.5" ry="10.5" fill="${INK}"/>
    <circle cx="${x + 2.8 + dx}" cy="${y - 3.8 + dy}" r="3.2" fill="#fff"/><circle cx="${x - 2.5 + dx}" cy="${y + 3.5 + dy}" r="1.4" fill="#fff" opacity=".7"/>`).join('')}</g>`;
}

function mouth(y, mood) {
  if (mood === 'happy') return `<path d="M88 ${y + 12} Q 100 ${y + 30} 112 ${y + 12} Z" fill="${INK}"/><ellipse cx="100" cy="${y + 21}" rx="5" ry="3" fill="#FF8C9B"/>`;
  if (mood === 'talking') return `<ellipse class="mouth-talk" cx="100" cy="${y + 18}" rx="7" ry="6" fill="${INK}"/>`;
  if (mood === 'thinking') return `<ellipse cx="106" cy="${y + 18}" rx="4" ry="3" fill="${INK}"/>`;
  if (mood === 'sleepy') return `<ellipse cx="100" cy="${y + 17}" rx="3.5" ry="2.5" fill="${INK}"/>`;
  return `<path d="M91 ${y + 14} Q 100 ${y + 22} 109 ${y + 14}" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`;
}

function extras(mood, c) {
  if (mood === 'thinking') return `<g class="think-dots" fill="${c.shade}"><circle cx="150" cy="44" r="5"/><circle cx="166" cy="34" r="6.5"/><circle cx="184" cy="20" r="8"/></g>`;
  if (mood === 'sleepy') return `<g class="zzz" fill="${c.shade}" font-family="ui-rounded, system-ui, sans-serif" font-weight="800"><text x="148" y="50" font-size="18">z</text><text x="162" y="34" font-size="24">z</text></g>`;
  return '';
}

// Illustrated characters: an outfit picture with a face patch drawn over it (same framing), in
// characters/<id>/outfits and characters/<id>/faces. Idle uses the outfit's own resting face and
// blinks; talking alternates the resting face with the open-mouth patch.
const PORTRAITS = { claude: true };
const FACE_FOR = { idle: null, listening: 'listening', thinking: 'thinking', talking: null, happy: 'happy', sleepy: 'sleepy' };

// feeling: the face the companion chose for its reply; shown instead of the talking and happy faces.
function portrait(character, mood, label, outfit = 'base', feeling = null) {
  const at = name => `characters/${character}/${name}.webp`;
  const picture = (name, cls = '') => `<image${cls ? ` class="${cls}"` : ''} href="${at(name)}" x="0" y="0" width="200" height="200" preserveAspectRatio="xMidYMid meet"/>`;
  const felt = feeling && (mood === 'talking' || mood === 'happy') ? feeling : null;
  const face = felt ? picture(`faces/${felt}`) : FACE_FOR[mood] ? picture(`faces/${FACE_FOR[mood]}`) : '';
  const overlay = felt ? '' : mood === 'talking' ? picture('faces/talk', 'frame-talk') : mood === 'idle' ? picture('faces/blink', 'frame-blink') : '';
  return `<svg class="char char-portrait char-${character} mood-${mood}" viewBox="0 0 200 200" role="img" aria-label="${label}" xmlns="http://www.w3.org/2000/svg">
  <g class="char-body">${picture(`outfits/${outfit}`)}${face}${overlay}</g>
</svg>`;
}

// Claude-chan's outfits (the server picks one when automatic: src/wardrobe.mjs).
export const OUTFITS = [['base', 'Signature'], ['cozy-home', 'Cozy at home'], ['pajamas', 'Pajamas'], ['spring', 'Spring'],
  ['summer', 'Summer'], ['sunny', 'Sunny day'], ['autumn', 'Autumn'], ['windy', 'Windy day'], ['winter', 'Winter'], ['rain', 'Rain'],
  ['snow', 'Snow'], ['halloween', 'Halloween'], ['christmas', 'Christmas'], ['party', "New Year's Eve"], ['new-year', 'New Year'],
  ['lunar-new-year', 'Lunar New Year'], ['valentine', "Valentine's"], ['easter', 'Easter'], ['summer-festival', 'Summer festival'],
  ['birthday', 'Birthday']];
export const HAS_OUTFITS = character => Object.hasOwn(PORTRAITS, character);
export const FEELINGS = ['happy', 'laugh', 'wink', 'surprised', 'sad', 'worried', 'teary-smile', 'embarrassed', 'pout', 'proud',
  'excited', 'confused', 'determined', 'tender', 'love', 'focused', 'thinking', 'sleepy'];
// The drawn characters have fewer faces: the nearest one.
const NEAREST = { happy: 'happy', laugh: 'happy', wink: 'happy', proud: 'happy', excited: 'happy', tender: 'happy', love: 'happy',
  'teary-smile': 'happy', thinking: 'thinking', confused: 'thinking', focused: 'thinking', sleepy: 'sleepy' };

export function renderCharacter({ character = 'pip', color = 'peach', mood = 'idle', title = '', outfit = 'base', feeling = null } = {}) {
  const felt = FEELINGS.includes(feeling) ? feeling : null;
  if (Object.hasOwn(PORTRAITS, character)) return portrait(character, MOODS.includes(mood) ? mood : 'idle', title.replace(/[<>&"]/g, ''),
    /^[a-z-]{1,32}$/.test(outfit) ? outfit : 'base', felt);
  if (felt && (mood === 'talking' || mood === 'happy') && NEAREST[felt]) mood = NEAREST[felt];
  const body = BODIES[character] ?? BODIES.pip, c = COLORS[color] ?? COLORS.peach, m = MOODS.includes(mood) ? mood : 'idle';
  const y = body.face;
  return `<svg class="char char-${character} mood-${m}" viewBox="0 0 200 200" role="img" aria-label="${title.replace(/[<>&"]/g, '')}" xmlns="http://www.w3.org/2000/svg">
  <ellipse class="char-shadow" cx="100" cy="188" rx="${body.shadow}" ry="7" fill="#000" opacity=".08"/>
  <g class="char-body">${body.draw(c)}
    <ellipse cx="62" cy="${y + 15}" rx="10" ry="6" fill="${c.cheek}" opacity=".55"/><ellipse cx="138" cy="${y + 15}" rx="10" ry="6" fill="${c.cheek}" opacity=".55"/>
    ${eyes(y, m)}${mouth(y, m)}
  </g>${extras(m, c)}
</svg>`;
}
