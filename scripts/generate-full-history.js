// Generate a "contribution landscape": the user's entire GitHub history
// rendered as a nature scene. Each year becomes a mountain ridge (weekly
// contribution volume shapes the relief), older years sit in the back,
// the current year in front. Uses GitHub's own green palette.
//
// The GitHub GraphQL API limits each contributionsCollection query to a
// one-year window, so the script fetches every year separately.
//
// Usage: GITHUB_TOKEN=... [GH_USERNAME=...] node scripts/generate-full-history.js
// (GH_USERNAME instead of USERNAME because Windows reserves that variable)

const fs = require('fs');

const TOKEN = process.env.GITHUB_TOKEN;
const USERNAME = process.env.GH_USERNAME || 'CristiancMartini';
if (!TOKEN) {
  console.error('GITHUB_TOKEN env var is required');
  process.exit(1);
}

// ---------------------------------------------------------------- fetch

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchAllYears() {
  const { user } = await graphql(
    'query($login: String!) { user(login: $login) { createdAt } }',
    { login: USERNAME },
  );
  const createdAt = new Date(user.createdAt);
  const now = new Date();

  const query = `
    query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`;

  // weekly contribution sums per year: { 2022: [53 numbers], ... }
  const years = {};
  let total = 0;
  for (let year = createdAt.getUTCFullYear(); year <= now.getUTCFullYear(); year++) {
    const from = Date.UTC(year, 0, 1);
    const to = Math.min(Date.UTC(year, 11, 31, 23, 59, 59), now.getTime());
    const data = await graphql(query, {
      login: USERNAME,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    const calendar = data.user.contributionsCollection.contributionCalendar;
    total += calendar.totalContributions;

    const weekly = new Array(53).fill(0);
    const jan1 = Date.UTC(year, 0, 1) / 86400000;
    const jan1Dow = new Date(Date.UTC(year, 0, 1)).getUTCDay();
    const firstSunday = jan1 - jan1Dow;
    for (const week of calendar.weeks) {
      for (const day of week.contributionDays) {
        const epochDay = Date.parse(day.date) / 86400000;
        const w = Math.min(52, Math.max(0, Math.floor((epochDay - firstSunday) / 7)));
        weekly[w] += day.contributionCount;
      }
    }
    years[year] = weekly;
    console.log(`${year}: ${calendar.totalContributions} contributions`);
  }

  return { years, total, createdAt, now };
}

// --------------------------------------------------------------- render

const WIDTH = 1280;
const HEIGHT = 640;
const SCENE_BOTTOM = 560; // mountains end here, footer band below

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
// day-of-year at the start of each month (non-leap; close enough for ticks)
const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const THEMES = {
  dark: {
    fileName: 'profile-3d-contrib/profile-full-dark.svg',
    bg: '#0d1117',
    fg: '#e6edf3',
    strong: '#39d353',
    weak: '#8b949e',
    // back (oldest) -> front (newest), GitHub dark greens
    ridges: ['#0a3520', '#0e4429', '#006d32', '#26a641', '#39d353'],
    ridgeFade: '#071210',
    tree: '#052e17',
    shade: 0.24,
    mist: '#9fe8b8',
    mistOpacity: 0.07,
    building: '#0a1220',
    window: '#ffd76a',
    sky: 'night',
  },
  light: {
    fileName: 'profile-3d-contrib/profile-full-light.svg',
    bg: '#ffffff',
    fg: '#1f2328',
    strong: '#1a7f37',
    weak: '#59636e',
    // atmospheric perspective: far = pale, near = deep green
    ridges: ['#c9f2d4', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
    ridgeFade: '#f2fcf5',
    tree: '#0f3d20',
    shade: 0.1,
    mist: '#ffffff',
    mistOpacity: 0.45,
    building: '#57606a',
    window: '#ffffff',
    sky: 'day',
  },
};

const n2 = (v) => (Math.round(v * 100) / 100).toString();

// mix a #rrggbb color toward another by factor f (0..1)
function mix(hex, target, f) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(target.slice(1), 16);
  const ch = (shift) => {
    const v = Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * f);
    return v.toString(16).padStart(2, '0');
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
const lighten = (hex, f) => mix(hex, '#ffffff', f);

// deterministic pseudo-random, so the sky doesn't change every run
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(values) {
  return values.map((v, i) => {
    const prev = values[i - 1] ?? v;
    const next = values[i + 1] ?? v;
    return (prev + 2 * v + next) / 4;
  });
}

const xAt = (week) => -20 + (week / 52) * (WIDTH + 40);

// Catmull-Rom spline through the points, as cubic beziers.
function ridgeCurve(points) {
  let d = `M ${n2(points[0][0])} ${n2(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${n2(c1[0])} ${n2(c1[1])}, ${n2(c2[0])} ${n2(c2[1])}, ${n2(p2[0])} ${n2(p2[1])}`;
  }
  return d;
}

// densely sample the Catmull-Rom spline (for peak detection and
// anchoring decorations exactly on the visible curve)
function densify(points, steps = 10) {
  const cubic = (p1, c1, c2, p2, t) => {
    const u = 1 - t;
    return [
      u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
      u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
    ];
  };
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    for (let s = 0; s < steps; s++) out.push(cubic(p1, c1, c2, p2, s / steps));
  }
  out.push(points[points.length - 1]);
  return out;
}

function yAtX(samples, x) {
  let best = samples[0];
  for (const p of samples) {
    if (Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
  }
  return best[1];
}

// local maxima of the curve (minimum y), spaced apart, tallest first
function findPeaks(samples, base, maxCount, minHeightRatio) {
  const maxH = Math.max(...samples.map(([, y]) => base - y), 1);
  const candidates = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i][1] < samples[i - 1][1] && samples[i][1] <= samples[i + 1][1]) {
      if (base - samples[i][1] >= minHeightRatio * maxH) candidates.push(samples[i]);
    }
  }
  candidates.sort((a, b) => a[1] - b[1]);
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxCount) break;
    if (picked.every((p) => Math.abs(p[0] - c[0]) > 70)) picked.push(c);
  }
  return picked;
}

// aurora ribbon: a blurred wavy band across the upper sky
function auroraRibbon(yBase, amplitude, phase, thickness) {
  const top = [];
  for (let x = -60; x <= WIDTH + 60; x += 80) {
    top.push([x, yBase + amplitude * Math.sin(x / 190 + phase)]);
  }
  const bottom = top.map(([x, y]) => [x, y + thickness]).reverse();
  const pts = [...top, ...bottom];
  let d = `M ${n2(pts[0][0])} ${n2(pts[0][1])}`;
  for (const [x, y] of pts.slice(1)) d += ` L ${n2(x)} ${n2(y)}`;
  return d + ' Z';
}

function nightSky(rand) {
  const parts = [];
  // aurora borealis in GitHub green
  parts.push(
    `<path d="${auroraRibbon(105, 26, 0.3, 46)}" fill="url(#aurora)" filter="url(#soften)" opacity="0.55"></path>`,
    `<path d="${auroraRibbon(150, 32, 2.1, 38)}" fill="url(#aurora)" filter="url(#soften)" opacity="0.35"></path>`,
  );
  for (let i = 0; i < 80; i++) {
    const cx = rand() * WIDTH;
    const cy = rand() * 240;
    const r = 0.5 + rand() * 1.2;
    const op = (0.25 + rand() * 0.65).toFixed(2);
    parts.push(`<circle cx="${n2(cx)}" cy="${n2(cy)}" r="${n2(r)}" fill="#e6edf3" opacity="${op}"></circle>`);
  }
  // shooting star
  parts.push(
    '<line x1="250" y1="62" x2="332" y2="92" stroke="url(#meteor)" stroke-width="2" stroke-linecap="round"></line>',
    '<circle cx="332" cy="92" r="1.8" fill="#e6edf3" opacity="0.95"></circle>',
  );
  // crescent moon
  parts.push('<circle cx="1130" cy="86" r="34" fill="#e6edf3" opacity="0.9"></circle>');
  parts.push('<circle cx="1144" cy="76" r="30" fill="#0d1117"></circle>');
  return parts.join('');
}

// small city skyline nestled in the flattest valley of the front ridge
function citySkyline(theme, samples, rand) {
  // find the 300px-wide window where the front ridge is lowest
  let bestX = WIDTH / 2;
  let bestScore = -Infinity;
  for (let cx = 190; cx <= WIDTH - 190; cx += 20) {
    const win = samples.filter(([x]) => Math.abs(x - cx) < 150);
    const score = win.reduce((acc, [, y]) => acc + y, 0) / Math.max(1, win.length);
    if (score > bestScore) {
      bestScore = score;
      bestX = cx;
    }
  }

  const parts = [];
  let tallest = null;
  let x = bestX - 150;
  while (x < bestX + 150) {
    const w = 17 + rand() * 17;
    const centerFactor = 1 - 0.45 * (Math.abs(x + w / 2 - bestX) / 150);
    const h = (36 + rand() * 64) * centerFactor;
    const top = SCENE_BOTTOM - h;
    parts.push(`<rect x="${n2(x)}" y="${n2(top)}" width="${n2(w)}" height="${n2(h + 2)}" fill="${theme.building}"></rect>`);

    // lit windows
    const cols = Math.floor((w - 7) / 7.5);
    const rows = Math.floor((h - 10) / 11);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (rand() < 0.42) {
          parts.push(
            `<rect x="${n2(x + 4.5 + c * 7.5)}" y="${n2(top + 5 + r * 11)}" width="3.4" height="5" fill="${theme.window}" opacity="0.9"></rect>`,
          );
        }
      }
    }
    if (!tallest || h > tallest[2]) tallest = [x + w / 2, top, h];
    x += w + 5;
  }
  // antenna on the tallest building
  if (tallest) {
    parts.push(
      `<line x1="${n2(tallest[0])}" y1="${n2(tallest[1])}" x2="${n2(tallest[0])}" y2="${n2(tallest[1] - 14)}" stroke="${theme.building}" stroke-width="2"></line>`,
      `<circle cx="${n2(tallest[0])}" cy="${n2(tallest[1] - 15)}" r="2" fill="${theme.window}"></circle>`,
    );
  }
  return parts.join('');
}

function cloud(cx, cy, s) {
  return (
    `<g fill="#ffffff" stroke="#d7e4f0" stroke-width="1.5" opacity="0.95">` +
    `<ellipse cx="${cx}" cy="${cy}" rx="${34 * s}" ry="${15 * s}"></ellipse>` +
    `<ellipse cx="${cx - 20 * s}" cy="${cy + 4 * s}" rx="${22 * s}" ry="${11 * s}"></ellipse>` +
    `<ellipse cx="${cx + 22 * s}" cy="${cy + 5 * s}" rx="${24 * s}" ry="${12 * s}"></ellipse>` +
    `</g>`
  );
}

function daySky() {
  const parts = [];
  parts.push('<circle cx="1130" cy="90" r="52" fill="#ffdf5d" opacity="0.3"></circle>');
  parts.push('<circle cx="1130" cy="90" r="36" fill="#ffdf5d"></circle>');
  parts.push(cloud(230, 105, 1.1), cloud(520, 70, 0.85), cloud(820, 120, 1.25));
  for (const [bx, by] of [[380, 150], [430, 128], [640, 160]]) {
    parts.push(
      `<path d="M ${bx} ${by} q 9 -9 18 0 q 9 -9 18 0" stroke="#59636e" stroke-width="2.2" fill="none" stroke-linecap="round"></path>`,
    );
  }
  return parts.join('');
}

function render(theme, years, total, createdAt, now) {
  const yearList = Object.keys(years).map(Number).sort();
  const count = yearList.length;
  const smoothed = yearList.map((y) => smooth(years[y]));
  const globalMax = Math.max(1, ...smoothed.flat());

  const defs = [];
  const body = [];

  // sky: vertical gradient + theme-specific decorations
  if (theme.sky === 'night') {
    defs.push(
      '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#04060c"></stop>' +
        '<stop offset="0.6" stop-color="#0d1117"></stop>' +
        '<stop offset="1" stop-color="#0f2019"></stop>' +
        '</linearGradient>',
      '<linearGradient id="aurora" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#39d353" stop-opacity="0"></stop>' +
        '<stop offset="0.5" stop-color="#39d353" stop-opacity="0.55"></stop>' +
        '<stop offset="1" stop-color="#2ea043" stop-opacity="0"></stop>' +
        '</linearGradient>',
      '<linearGradient id="meteor" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#e6edf3" stop-opacity="0"></stop>' +
        '<stop offset="1" stop-color="#e6edf3" stop-opacity="0.9"></stop>' +
        '</linearGradient>',
      '<filter id="soften" x="-20%" y="-60%" width="140%" height="220%">' +
        '<feGaussianBlur stdDeviation="13"></feGaussianBlur>' +
        '</filter>',
    );
  } else {
    defs.push(
      '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#d6ecff"></stop>' +
        '<stop offset="1" stop-color="#ffffff"></stop>' +
        '</linearGradient>',
    );
  }
  body.push(`<rect x="0" y="0" width="${WIDTH}" height="${SCENE_BOTTOM}" fill="url(#sky)"></rect>`);
  body.push(theme.sky === 'night' ? nightSky(mulberry32(42)) : daySky());

  // mist between distant ridges (atmospheric depth)
  defs.push(
    `<linearGradient id="mist" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${theme.mist}" stop-opacity="0"></stop>` +
      `<stop offset="0.5" stop-color="${theme.mist}" stop-opacity="${theme.mistOpacity}"></stop>` +
      `<stop offset="1" stop-color="${theme.mist}" stop-opacity="0"></stop>` +
      `</linearGradient>`,
  );

  // one ridge per year, oldest in the back
  const baseTop = 320;
  const baseBottom = 545;
  let frontSamples = null;
  let frontBase = 0;
  yearList.forEach((year, i) => {
    const base = count === 1 ? baseBottom : baseTop + (i * (baseBottom - baseTop)) / (count - 1);
    const amp = 130 + (i * 80) / Math.max(1, count - 1);
    const color = theme.ridges[Math.min(i, theme.ridges.length - 1)];

    defs.push(
      `<linearGradient id="ridge${i}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${color}"></stop>` +
        `<stop offset="1" stop-color="${theme.ridgeFade}"></stop>` +
        `</linearGradient>`,
    );

    const pts = smoothed[i].map((v, w) => [xAt(w), base - (v / globalMax) * amp]);
    const curve = ridgeCurve(pts);
    const closed = `${curve} L ${n2(xAt(52))} ${SCENE_BOTTOM + 2} L ${n2(xAt(0))} ${SCENE_BOTTOM + 2} Z`;

    defs.push(`<clipPath id="rclip${i}"><path d="${closed}"></path></clipPath>`);
    body.push(`<path d="${closed}" fill="url(#ridge${i})" stroke="none"></path>`);
    // inner shading: a shifted dark copy clipped to the ridge leaves the
    // sun-lit crest visible and gives the slope some volume
    body.push(
      `<g clip-path="url(#rclip${i})">` +
        `<path d="${closed}" transform="translate(10 9)" fill="#000000" opacity="${theme.shade}"></path>` +
        `</g>`,
    );
    // crest highlight
    body.push(
      `<path d="${curve}" fill="none" stroke="${lighten(color, 0.35)}" stroke-width="1.6" opacity="0.75"></path>`,
    );
    if (i < count - 1) {
      body.push(`<rect x="0" y="${n2(base - 26)}" width="${WIDTH}" height="60" fill="url(#mist)"></rect>`);
    } else {
      frontSamples = densify(pts);
      frontBase = base;
    }
  });

  // snow caps anchored on the actual rendered curve
  const snowColor = theme.sky === 'night' ? '#e8f1f8' : '#ffffff';
  const peaks = findPeaks(frontSamples, frontBase, 5, 0.55);
  for (const [sx, sy] of peaks) {
    const yL = yAtX(frontSamples, sx - 12);
    const yR = yAtX(frontSamples, sx + 12);
    const lin = (t) => yL + (yR - yL) * t;
    body.push(
      `<path d="M ${n2(sx - 12)} ${n2(yL + 1)} L ${n2(sx)} ${n2(sy - 2)} L ${n2(sx + 12)} ${n2(yR + 1)} ` +
        `L ${n2(sx + 4)} ${n2(lin(0.67) + 4)} L ${n2(sx)} ${n2(lin(0.5) + 9)} L ${n2(sx - 4)} ${n2(lin(0.33) + 4)} Z" ` +
        `fill="${snowColor}" opacity="0.93"></path>`,
    );
  }

  // pine trees on the front ridge slopes (kept off the snowy peaks)
  const treeRand = mulberry32(7);
  const maxFrontH = Math.max(...frontSamples.map(([, y]) => frontBase - y), 1);
  let trees = 0;
  for (let k = 6; k < frontSamples.length - 6 && trees < 12; k += 9) {
    const [tx, ty] = frontSamples[k];
    const rel = (frontBase - ty) / maxFrontH;
    const nearPeak = peaks.some(([px]) => Math.abs(px - tx) < 34);
    if (rel > 0.3 && rel < 0.75 && !nearPeak && treeRand() < 0.8) {
      const h = 14 + 14 * rel;
      const w = 5 + 3 * rel;
      body.push(
        `<path d="M ${n2(tx - w)} ${n2(ty + 3)} L ${n2(tx)} ${n2(ty - h)} L ${n2(tx + w)} ${n2(ty + 3)} Z" fill="${theme.tree}"></path>`,
      );
      trees++;
    }
  }

  // city in the flattest valley of the front ridge
  body.push(citySkyline(theme, frontSamples, mulberry32(1234)));

  // footer band: month ticks, totals, year legend
  body.push(`<rect x="0" y="${SCENE_BOTTOM}" width="${WIDTH}" height="${HEIGHT - SCENE_BOTTOM}" fill="${theme.bg}"></rect>`);

  MONTH_STARTS.forEach((d, m) => {
    const x = xAt(d / 7);
    if (x > 24 && x < WIDTH - 24) {
      body.push(`<text x="${n2(x)}" y="${SCENE_BOTTOM + 22}" font-size="12px" text-anchor="middle" class="fill-weak">${MONTHS_PT[m]}</text>`);
    }
  });

  const startLabel = `${MONTHS_PT[createdAt.getUTCMonth()]}/${createdAt.getUTCFullYear()}`;
  const endLabel = `${MONTHS_PT[now.getUTCMonth()]}/${now.getUTCFullYear()}`;
  body.push(
    `<text x="40" y="${HEIGHT - 24}">` +
      `<tspan font-size="30px" font-weight="bold" class="fill-strong">${total.toLocaleString('pt-BR')}</tspan>` +
      `<tspan font-size="19px" class="fill-fg" dx="9">contributions</tspan>` +
      `<tspan font-size="14px" class="fill-weak" dx="12">${startLabel} — ${endLabel}</tspan>` +
      `</text>`,
  );

  const itemW = 78;
  const legendStart = WIDTH - 40 - count * itemW;
  yearList.forEach((year, i) => {
    const x = legendStart + i * itemW;
    const color = theme.ridges[Math.min(i, theme.ridges.length - 1)];
    body.push(`<rect x="${x}" y="${HEIGHT - 42}" width="13" height="13" rx="3" fill="${color}"></rect>`);
    body.push(`<text x="${x + 19}" y="${HEIGHT - 31}" font-size="14px" class="fill-weak">${year}</text>`);
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
    `<style>* { font-family: "Ubuntu", "Helvetica", "Arial", sans-serif; }\n` +
    `.fill-fg { fill: ${theme.fg}; }\n.fill-strong { fill: ${theme.strong}; }\n.fill-weak { fill: ${theme.weak}; }</style>` +
    `<defs>${defs.join('')}</defs>` +
    `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${theme.bg}"></rect>` +
    body.join('') +
    `</svg>`;

  fs.mkdirSync('profile-3d-contrib', { recursive: true });
  fs.writeFileSync(theme.fileName, svg);
  console.log(`written: ${theme.fileName} (${WIDTH}x${HEIGHT}, ${count} ridges)`);
}

// ----------------------------------------------------------------- main

(async () => {
  const { years, total, createdAt, now } = await fetchAllYears();
  console.log(`total: ${total} contributions`);
  for (const theme of Object.values(THEMES)) {
    render(theme, years, total, createdAt, now);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
