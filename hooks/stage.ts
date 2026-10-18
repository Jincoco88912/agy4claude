// The pane's drawings: the starry stage with the anti-gravity robot and the account planets, the
// header mark, the savings chip and the chat avatars. Pure functions from data to SVG text; the
// hooks module steps `t` (seconds) on its clock so the stage moves, about eight frames a second.
// Every drawing carries its own dark ground or neutral tones, so it reads on a light or dark theme.

export type Mood = 'idle' | 'thinking' | 'reading' | 'running' | 'done' | 'error' | 'sleeping'

export type Planet = { name: string; left: number; current: boolean }

export type StageInput = {
  mood: Mood
  /** Seconds since the session started; drives every motion. */
  t: number
  planets: Planet[]
  /** The pill in the top right, e.g. "Running · account b". */
  status: string
  /** The big clock, e.g. "00:42"; empty draws none. */
  timer: string
  /** One line under the clock. */
  sub: string
}

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang TC', 'Segoe UI', sans-serif"
const MONO = "ui-monospace, 'SF Mono', Menlo, monospace"
// Control characters (an ANSI escape in a command line, say) are not allowed in XML: drop them first.
const esc = (text: string): string =>
  text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const r1 = (n: number): string => (Math.round(n * 10) / 10).toString()

/** About how wide a text draws: CJK and other wide characters take a full em, the rest about 0.58. */
const textWidth = (text: string, size: number): number =>
  [...text].reduce((w, ch) => w + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? size : size * 0.58), 0)

const clip = (text: string, max: number): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text)

// ---- the robot ------------------------------------------------------------
// One letter per pixel: o outline, s suit, h suit shade, V visor, E eye, T antenna tip, F flame.

const SPRITE = [
  '.....T.........',
  '......o........',
  '...oooooooo....',
  '..osssssssso...',
  '.osVVVVVVVVso..',
  '.osVEVVVVEVso..',
  '.osVVVVVVVVso..',
  '.oshVVVVVVhso..',
  '..osssssssso...',
  '.oossshhsssoo..',
  'osso.ossso.osso',
  '.oo..ohhho..oo.',
  '.....oo.oo.....',
  '.....FF.FF.....',
  '......F..F.....',
]

const SPRITE_COLORS: Record<string, string> = {
  o: '#312E81', s: '#EEF2FF', h: '#C7D2FE', V: '#1E1B4B', T: '#FB923C', F: '#FB923C',
}

const EYE: Record<Mood, string> = {
  idle: '#67E8F9', thinking: '#67E8F9', reading: '#67E8F9', running: '#67E8F9',
  done: '#A7F3D0', error: '#FCA5A5', sleeping: '#A1A1AA',
}

/** The sprite's rows for a mood (and a blink), as letters. */
const spriteRows = (mood: Mood, blink: boolean, flame: 0 | 1 | 2): string[] =>
  SPRITE.map((row, y) => {
    if (y === 4 && mood === 'done') return '.osVEVVVVEVso..' // eyes lifted: a smile
    if (y === 5 && mood === 'done') return '.osVVEVVEVVso..'
    if (y === 5 && (mood === 'sleeping' || blink)) return '.osVVVVVVVVso..'
    if (y === 6 && (mood === 'sleeping' || blink)) return '.osVEEVVEEVso..'
    if (y === 13) return flame === 0 ? '...............' : row
    if (y === 14) return flame < 2 ? '...............' : row
    return row
  })

/** The sprite as one path per colour, in pixel units. */
const spritePaths = (mood: Mood, blink: boolean, flame: 0 | 1 | 2): string => {
  const paths: Record<string, string> = {}
  spriteRows(mood, blink, flame).forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const k = row[x]!
      if (k === '.') continue
      paths[k] = `${paths[k] ?? ''}M${x} ${y}h1v1h-1z`
    }
  })
  return Object.entries(paths)
    .map(([k, d]) => `<path d="${d}" fill="${k === 'E' ? EYE[mood] : SPRITE_COLORS[k]}"/>`)
    .join('')
}

const BADGE: Record<Mood, { text: string; color: string }> = {
  idle: { text: '', color: '#fff' },
  thinking: { text: '…', color: '#C7D2FE' },
  reading: { text: '?', color: '#93C5FD' },
  running: { text: '>_', color: '#FDBA74' },
  done: { text: '✓', color: '#A7F3D0' },
  error: { text: '✕', color: '#FCA5A5' },
  sleeping: { text: 'z', color: '#D4D4D8' },
}

const GROUND: Record<Mood, string> = {
  idle: '#2A2766', thinking: '#2A2766', reading: '#1E3A8A', running: '#3B1D7A',
  done: '#1F6446', error: '#7F1D1D', sleeping: '#27272A',
}

/** One colour per account, in order; how full a planet is shows in its size and brightness. */
export const PLANET_COLORS = ['#A5B4FC', '#7DD3FC', '#F9A8D4', '#FCD34D', '#86EFAC', '#FDBA74'] as const

// ---- the stage ------------------------------------------------------------

const W = 440
const H = 220
const CX = 100
const CY = 98

const STARS: readonly [number, number, number, number][] = [
  [40, 30, 1.4, 0], [212, 20, 1, 0.8], [162, 68, 1.2, 1.4], [400, 44, 1.4, 0.4],
  [310, 186, 1, 1.9], [20, 168, 1.1, 1.1], [254, 124, 0.9, 2.1], [360, 98, 0.8, 2.7],
]

/** The stage at time `t`: stars, orbits, account planets with bloom, the robot, and the clock. */
export const stageSvg = (s: StageInput): string => {
  const { mood, t } = s
  const live = mood === 'thinking' || mood === 'reading' || mood === 'running'
  const bob = mood === 'sleeping' ? Math.sin(t * 1.2) * 2 : Math.sin((t * 2 * Math.PI) / 2.6) * 5
  const blink = mood !== 'sleeping' && t % 4 < 0.14
  const frame = Math.floor(t * 8)
  const flame: 0 | 1 | 2 = mood === 'error' || mood === 'sleeping' ? 0 : mood === 'running' ? (frame % 2 ? 2 : 1) : frame % 3 === 0 ? 1 : 2
  const out: string[] = []

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    '<defs>',
    `<radialGradient id="g" cx="0.2" cy="1" r="1.1"><stop offset="0" stop-color="${GROUND[mood]}"/><stop offset="0.62" stop-color="#17171C"/></radialGradient>`,
    '<filter id="bloom" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur in="SourceGraphic" stdDeviation="3.2" result="a"/><feGaussianBlur in="SourceGraphic" stdDeviation="8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="a"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    '<radialGradient id="flare" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>',
    '</defs>',
    `<rect width="${W}" height="${H}" rx="16" fill="url(#g)"/>`,
  )

  for (const [x, y, r, phase] of STARS) {
    const o = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin((t + phase) * 2.6))
    out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity="${r1(o)}"/>`)
  }

  // Orbits and planets: even indices on the inner ring, odd on the outer, spread evenly.
  out.push(
    `<circle cx="${CX}" cy="${CY}" r="58" fill="none" stroke="#C7D2FE" stroke-opacity=".14"/>`,
    `<circle cx="${CX}" cy="${CY}" r="78" fill="none" stroke="#C7D2FE" stroke-opacity=".08"/>`,
  )
  const n = s.planets.length
  s.planets.forEach((p, i) => {
    const outer = i % 2 === 1
    const radius = outer ? 78 : 58
    const speed = outer ? -360 / 26 : 360 / 16
    const angle = ((-90 + (360 * i) / Math.max(1, n) + t * speed) * Math.PI) / 180
    const x = CX + radius * Math.cos(angle)
    const y = CY + radius * Math.sin(angle)
    const known = p.left >= 0
    const share = known ? Math.max(0, Math.min(100, p.left)) / 100 : 0
    const size = known ? 3.2 + share * 4.2 : 3
    const alpha = known ? 0.4 + share * 0.6 : 0.3
    const color = PLANET_COLORS[i % PLANET_COLORS.length]
    out.push(`<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(size)}" fill="${color}" fill-opacity="${r1(alpha)}" filter="url(#bloom)"/>`)
    if (p.current) {
      const glint = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.8))
      out.push(
        `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(size + 4.5)}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/>`,
        `<g opacity="${r1(glint)}"><rect x="${r1(x - 0.6)}" y="${r1(y - 18)}" width="1.2" height="36" fill="url(#flare)"/><rect x="${r1(x - 18)}" y="${r1(y - 0.6)}" width="36" height="1.2" fill="url(#flare)"/></g>`,
      )
    }
  })

  // Confetti for a finished run.
  if (mood === 'done') {
    const bits: readonly [number, string, number][] = [[62, '#A7F3D0', 0], [124, '#FCD34D', 0.5], [152, '#A5B4FC', 1], [44, '#FB923C', 1.3]]
    for (const [x, c, delay] of bits) {
      const k = ((t + delay) % 1.8) / 1.8
      out.push(`<rect x="${x}" y="${r1(14 + k * 70)}" width="4" height="4" fill="${c}" fill-opacity="${r1(1 - k)}"/>`)
    }
  }

  // The robot, 3.6 px per sprite pixel, centred in the orbits.
  out.push(
    `<g transform="translate(${CX - 27} ${r1(CY - 28 + bob)}) scale(3.6)" shape-rendering="crispEdges">${spritePaths(mood, blink, flame)}</g>`,
  )
  const badge = BADGE[mood]
  if (badge.text) {
    const lift = live ? Math.sin(t * 4) * 2 : 0
    out.push(`<text x="${CX + 26}" y="${r1(CY - 30 + bob + lift)}" font-family="${MONO}" font-size="15" font-weight="700" fill="${badge.color}">${esc(badge.text)}</text>`)
  }

  // Right side: state pill, clock, one line.
  const status = clip(s.status, 30)
  const pillW = Math.min(W - 230, Math.max(90, Math.round(textWidth(status, 12)) + 32))
  const dot = mood === 'done' ? '#6EE7B7' : mood === 'error' ? '#F87171' : mood === 'sleeping' ? '#A1A1AA' : '#A5B4FC'
  const pulse = live ? 3 + 1.5 * (0.5 + 0.5 * Math.sin(t * 5.2)) : 3.5
  out.push(
    `<rect x="${W - 18 - pillW}" y="20" width="${pillW}" height="24" rx="12" fill="#fff" fill-opacity=".12"/>`,
    `<circle cx="${W - 18 - pillW + 14}" cy="32" r="${r1(pulse)}" fill="${dot}"/>`,
    `<text x="${W - 18 - pillW + 24}" y="36.5" font-family="${FONT}" font-size="12" font-weight="500" fill="#E0E7FF">${esc(status)}</text>`,
  )
  if (s.timer) {
    out.push(`<text x="${W - 18}" y="92" text-anchor="end" font-family="${FONT}" font-size="40" font-weight="600" fill="#fff" style="font-variant-numeric: tabular-nums">${esc(s.timer)}</text>`)
  }
  if (s.sub) out.push(`<text x="${W - 18}" y="114" text-anchor="end" font-family="${FONT}" font-size="12" fill="#A1A1AA">${esc(s.sub)}</text>`)

  // Legend: each planet's colour, name and quota, the current one in white.
  let lx = 16
  s.planets.forEach((p, i) => {
    if (lx < 0) return
    const label = `${clip(p.name, 10)} ${p.left < 0 ? '?' : `${Math.max(0, Math.min(100, p.left))}%`}`
    const width = 20 + textWidth(label, 12)
    if (lx + width > W - 16) {
      out.push(`<text x="${lx}" y="${H - 14}" font-family="${FONT}" font-size="12" fill="#A1A1AA">+${s.planets.length - i}</text>`)
      lx = -1
      return
    }
    const color = PLANET_COLORS[i % PLANET_COLORS.length]
    out.push(
      `<circle cx="${lx + 4}" cy="${H - 18}" r="${p.current ? 4 : 3.4}" fill="${color}"${p.current ? ' stroke="#fff" stroke-opacity=".7" stroke-width="1.4"' : ''}/>`,
      `<text x="${lx + 12}" y="${H - 14}" font-family="${FONT}" font-size="12" ${p.current ? 'font-weight="600" fill="#fff"' : 'fill="#A1A1AA"'}>${esc(label)}</text>`,
    )
    lx += width
  })

  out.push('</svg>')
  return out.join('')
}

// ---- small marks ----------------------------------------------------------

/** The header mark: the planet with its orbit and a gold moon, on graphite. */
export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
  '<rect width="34" height="34" rx="10" fill="#18181B"/>' +
  '<ellipse cx="17" cy="17" rx="11" ry="4.6" fill="none" stroke="#A5B4FC" stroke-width="1.5" transform="rotate(-28 17 17)"/>' +
  '<circle cx="17" cy="17" r="4.2" fill="#fff"/><circle cx="25.5" cy="11.6" r="2" fill="#FCD34D"/></svg>'

/** The savings chip: a gold coin, the running total and today's share, on graphite. */
export const savingsSvg = (label: string, total: string, today: string): string => {
  const totalW = Math.round(total.length * 8.4)
  const todayW = Math.round(today.length * 6.4)
  const w = 40 + Math.max(totalW, Math.round(label.length * 6.6)) + 18 + todayW + 14
  const sep = 40 + Math.max(totalW, Math.round(label.length * 6.6)) + 9
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="34" viewBox="0 0 ${w} 34">` +
    '<defs><linearGradient id="c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FDE68A"/><stop offset=".55" stop-color="#F5B83D"/><stop offset="1" stop-color="#C9851A"/></linearGradient></defs>' +
    `<rect width="${w}" height="34" rx="10" fill="#18181B"/>` +
    '<g transform="translate(8 6)"><circle cx="11" cy="11" r="10" fill="url(#c)"/><circle cx="11" cy="11" r="7.4" fill="none" stroke="#FFF7D6" stroke-opacity=".6"/>' +
    '<path d="M11 6.2v9.6M13.3 8.2c-.5-.6-1.3-.9-2.3-.9-1.3 0-2.2.6-2.2 1.6 0 2.3 4.7 1.2 4.7 3.6 0 1-1 1.7-2.5 1.7-1.1 0-2-.4-2.6-1" fill="none" stroke="#7A4E08" stroke-width="1.3" stroke-linecap="round"/></g>' +
    `<text x="38" y="14" font-family="${FONT}" font-size="10" letter-spacing=".04em" fill="#A1A1AA">${esc(label)}</text>` +
    `<text x="38" y="28" font-family="${FONT}" font-size="14" font-weight="600" fill="#F5C451" style="font-variant-numeric: tabular-nums">${esc(total)}</text>` +
    `<rect x="${sep}" y="9" width="1" height="16" fill="#3F3F46"/>` +
    `<text x="${sep + 9}" y="21.5" font-family="${FONT}" font-size="11" fill="#D4D4D8" style="font-variant-numeric: tabular-nums">${esc(today)}</text>` +
    '</svg>'
}

/** Claude's avatar in the thread: a spark on warm sand. */
export const CLAUDE_AVATAR =
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 28 28">' +
  '<rect width="28" height="28" rx="14" fill="#F4E4DC"/>' +
  '<path d="M14 6v16M6 14h16M8.3 8.3l11.4 11.4M19.7 8.3L8.3 19.7" stroke="#C96442" stroke-width="2.2" stroke-linecap="round"/></svg>'

/** The robot's head as the agent's avatar in the thread. */
export const ROBOT_AVATAR = (() => {
  const head = SPRITE.slice(0, 9)
  const paths: Record<string, string> = {}
  head.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const k = row[x]!
      if (k === '.') continue
      paths[k] = `${paths[k] ?? ''}M${x} ${y}h1v1h-1z`
    }
  })
  const body = Object.entries(paths).map(([k, d]) => `<path d="${d}" fill="${k === 'E' ? '#67E8F9' : SPRITE_COLORS[k]}"/>`).join('')
  return '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 28 28">' +
    `<rect width="28" height="28" rx="14" fill="#E0E7FF"/><g transform="translate(4.2 5.2) scale(1.4)" shape-rendering="crispEdges">${body}</g></svg>`
})()

// ---- moods and savings -------------------------------------------------------

/** What the robot acts out for the newest run, given the tool it is on. */
export const moodOf = (
  run: { status: string; endedAt?: number; steps: { type: string; tool?: string; state: string }[] } | undefined,
  allSpent: boolean,
  now: number,
): Mood => {
  if (run && (run.status === 'starting' || run.status === 'running')) {
    const step = [...run.steps].reverse().find(one => one.type === 'tool' && one.state !== 'DONE') ?? run.steps[run.steps.length - 1]
    const tool = step?.tool ?? ''
    if (!step) return 'thinking'
    if (/command|shell|exec|terminal|edit|write|replace|create/i.test(tool)) return 'running'
    if (/view|read|grep|list|search|find|glob|url|browse|fetch|file/i.test(tool)) return 'reading'
    return 'thinking'
  }
  if (allSpent) return 'sleeping'
  if (!run) return 'idle'
  const recent = run.endedAt !== undefined && now - run.endedAt < 120_000
  if (run.status === 'done' && recent) return 'done'
  if (run.status === 'error' && recent) return 'error'
  return 'idle'
}

/** What a run would have cost on Claude at the given per-million prices: input, and output plus thinking. */
export const savedUsd = (usage: { input: number; output: number; thinking: number } | undefined, priceIn: number, priceOut: number): number =>
  usage ? (usage.input * priceIn + (usage.output + usage.thinking) * priceOut) / 1_000_000 : 0

export const fmtUsd = (usd: number): string => `US$${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
