import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Link } from 'react-router-dom'

type FeatureKind = 'mesh' | 'speed' | 'modular' | 'secure'
type ModelLogoId = 'nvidia' | 'mistral' | 'deepseek' | 'qwen' | 'llama' | 'gemini' | 'huggingface' | 'pytorch' | 'langchain'

type Point = {
  x: number
  y: number
}

type Edge = [Point, Point]

type HeroParticle = Point & {
  vx: number
  vy: number
  tx: number
  ty: number
  size: number
  color: string
  phase: number
  drift: number
}

type WordParticle = Point & {
  vx: number
  vy: number
  tx: number
  ty: number
  size: number
  color: string
  phase: number
}

type ShapeParticle = Point & {
  vx: number
  vy: number
  base: Point
  phase: number
  size: number
}

const modelColors = {
  nvidia: '#76b900',
  mistral: '#ff8a1f',
  deepseek: '#4f6dff',
  qwen: '#6548f6',
  llama: '#1688e8',
  microsoft: '#00a4ef',
}

const palette = [
  modelColors.nvidia,
  modelColors.mistral,
  modelColors.deepseek,
  modelColors.qwen,
  modelColors.llama,
  modelColors.microsoft,
]

const stats = [
  { value: '12,847', label: 'GPU en ligne', color: modelColors.nvidia },
  { value: '3.21M', label: 'requêtes servies', color: modelColors.qwen },
  { value: '238ms', label: 'latence médiane', color: modelColors.deepseek },
  { value: '99.97%', label: 'disponibilité réseau', color: modelColors.mistral },
  { value: '120+', label: 'pays couverts', color: modelColors.microsoft },
]

const features: { kind: FeatureKind; color: string; title: string; body: string }[] = [
  {
    kind: 'mesh',
    color: modelColors.nvidia,
    title: 'Réseau GPU mondial',
    body: 'Des machines disponibles s’agrègent en temps réel pour former une capacité distribuée.',
  },
  {
    kind: 'speed',
    color: modelColors.deepseek,
    title: 'Routage haute vitesse',
    body: 'Les calculs trouvent le meilleur chemin entre proximité, charge et capacité effective.',
  },
  {
    kind: 'modular',
    color: modelColors.qwen,
    title: 'Écosystème ouvert',
    body: 'Modèles, moteurs d’exécution et nœuds se connectent librement sur une même couche de calcul.',
  },
  {
    kind: 'secure',
    color: modelColors.mistral,
    title: 'Exécution isolée',
    body: 'Chaque calcul reste borné, éphémère et segmenté pour protéger les charges sensibles.',
  },
]

const logos = [
  { id: 'nvidia', alt: 'NVIDIA' },
  { id: 'mistral', alt: 'Mistral AI' },
  { id: 'deepseek', alt: 'DeepSeek' },
  { id: 'qwen', alt: 'Qwen' },
  { id: 'llama', alt: 'Llama' },
  { id: 'gemini', alt: 'Gemma' },
  { id: 'huggingface', alt: 'Hugging Face' },
  { id: 'pytorch', alt: 'PyTorch' },
  { id: 'langchain', alt: 'LangChain' },
] satisfies { id: ModelLogoId; alt: string }[]

const logoGlyphs: Record<ModelLogoId, ReactNode> = {
  nvidia: (
    <path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z" />
  ),
  mistral: (
    <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
  ),
  deepseek: (
    <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
  ),
  qwen: (
    <path d="M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" />
  ),
  llama: (
    <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
  ),
  gemini: (
    <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
  ),
  huggingface: (
    <path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624" />
  ),
  pytorch: (
    <path d="M12.005 0L4.952 7.053a9.865 9.865 0 000 14.022 9.866 9.866 0 0014.022 0c3.984-3.9 3.986-10.205.085-14.023l-1.744 1.743c2.904 2.905 2.904 7.634 0 10.538s-7.634 2.904-10.538 0-2.904-7.634 0-10.538l4.647-4.646.582-.665zm3.568 3.899a1.327 1.327 0 00-1.327 1.327 1.327 1.327 0 001.327 1.328A1.327 1.327 0 0016.9 5.226 1.327 1.327 0 0015.573 3.9z" />
  ),
  langchain: (
    <path d="M7.53 15.975a7.53 7.53 0 0 0 2.206-5.325A7.54 7.54 0 0 0 7.53 5.325L2.205 0A7.54 7.54 0 0 0 0 5.325a7.54 7.54 0 0 0 2.205 5.325zm11.144.493a7.54 7.54 0 0 0-5.325-2.206 7.54 7.54 0 0 0-5.325 2.206l5.325 5.325a7.54 7.54 0 0 0 5.325 2.205A7.54 7.54 0 0 0 24 21.793zM2.219 21.78a7.54 7.54 0 0 0 5.325 2.205v-7.53H.014a7.54 7.54 0 0 0 2.205 5.325M20.73 8.595a7.53 7.53 0 0 0-5.327-2.206 7.53 7.53 0 0 0-5.325 2.207l5.325 5.325z" />
  ),
}

function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  return { width, height }
}

function addLine(pts: Point[], edges: Edge[], x1: number, y1: number, x2: number, y2: number, steps = 16) {
  let previous: Point | null = null
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const point = { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }
    pts.push(point)
    if (previous) edges.push([previous, point])
    previous = point
  }
}

function addCurve(
  pts: Point[],
  edges: Edge[],
  start: Point,
  controlA: Point,
  controlB: Point,
  end: Point,
  steps = 32,
) {
  let previous: Point | null = null
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    const point = {
      x: mt ** 3 * start.x + 3 * mt ** 2 * t * controlA.x + 3 * mt * t ** 2 * controlB.x + t ** 3 * end.x,
      y: mt ** 3 * start.y + 3 * mt ** 2 * t * controlA.y + 3 * mt * t ** 2 * controlB.y + t ** 3 * end.y,
    }
    pts.push(point)
    if (previous) edges.push([previous, point])
    previous = point
  }
}

function addRect(pts: Point[], edges: Edge[], x: number, y: number, width: number, height: number, steps = 8) {
  addLine(pts, edges, x, y, x + width, y, steps)
  addLine(pts, edges, x + width, y, x + width, y + height, steps)
  addLine(pts, edges, x + width, y + height, x, y + height, steps)
  addLine(pts, edges, x, y + height, x, y, steps)
}

function addCircle(
  pts: Point[],
  edges: Edge[],
  cx: number,
  cy: number,
  radius: number,
  steps = 42,
  start = 0,
  end = Math.PI * 2,
) {
  let previous: Point | null = null
  let first: Point | null = null
  for (let i = 0; i <= steps; i += 1) {
    const angle = start + ((end - start) * i) / steps
    const point = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
    pts.push(point)
    if (previous) {
      edges.push([previous, point])
    } else {
      first = point
    }
    previous = point
  }
  if (first && previous && end - start >= Math.PI * 2 - 0.01) edges.push([previous, first])
}

function makeFeatureTargets(kind: FeatureKind, width: number, height: number) {
  const pts: Point[] = []
  const edges: Edge[] = []
  const center = { x: width * 0.5, y: height * 0.5 }
  const unit = Math.min(width, height)

  function addPolyline(path: Point[]) {
    let previous: Point | null = null
    path.forEach((point) => {
      pts.push(point)
      if (previous) edges.push([previous, point])
      previous = point
    })
  }

  function addPolygon(cx: number, cy: number, radius: number, sides: number, rotation = -Math.PI / 2) {
    const path: Point[] = []
    for (let i = 0; i <= sides; i += 1) {
      const angle = rotation + (i / sides) * Math.PI * 2
      path.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
    }
    addPolyline(path)
  }

  if (kind === 'mesh') {
    const boardX = width * 0.14
    const boardY = height * 0.28
    const boardW = width * 0.72
    const boardH = height * 0.38
    addRect(pts, edges, boardX, boardY, boardW, boardH, 24)
    addRect(pts, edges, boardX + boardW * 0.12, boardY + boardH * 0.25, boardW * 0.2, boardH * 0.5, 12)
    addCircle(pts, edges, boardX + boardW * 0.5, boardY + boardH * 0.5, unit * 0.12, 44)
    addCircle(pts, edges, boardX + boardW * 0.5, boardY + boardH * 0.5, unit * 0.045, 24)
    addCircle(pts, edges, boardX + boardW * 0.73, boardY + boardH * 0.5, unit * 0.105, 42)
    addCircle(pts, edges, boardX + boardW * 0.73, boardY + boardH * 0.5, unit * 0.038, 22)
    addRect(pts, edges, boardX + boardW * 0.1, boardY + boardH, boardW * 0.42, height * 0.06, 12)
    addRect(pts, edges, boardX + boardW * 0.66, boardY - height * 0.08, boardW * 0.16, height * 0.08, 8)
    addLine(pts, edges, boardX + boardW * 0.03, boardY + boardH * 0.18, boardX - width * 0.06, boardY + boardH * 0.18, 8)
    addLine(pts, edges, boardX + boardW * 0.03, boardY + boardH * 0.82, boardX - width * 0.06, boardY + boardH * 0.82, 8)
    addLine(pts, edges, boardX + boardW, boardY + boardH * 0.34, boardX + boardW + width * 0.06, boardY + boardH * 0.34, 8)
    addLine(pts, edges, boardX + boardW, boardY + boardH * 0.66, boardX + boardW + width * 0.06, boardY + boardH * 0.66, 8)
    for (let i = 0; i < 8; i += 1) {
      const x = boardX + boardW * (0.16 + i * 0.075)
      addLine(pts, edges, x, boardY + boardH, x, boardY + boardH + height * 0.06, 3)
    }
    const tracePoints = [
      [0.29, 0.38, 0.42, 0.42],
      [0.31, 0.56, 0.42, 0.52],
      [0.58, 0.38, 0.66, 0.44],
      [0.58, 0.58, 0.66, 0.53],
    ]
    tracePoints.forEach(([x1, y1, x2, y2]) => addLine(pts, edges, width * x1, height * y1, width * x2, height * y2, 10))
  }

  if (kind === 'speed') {
    const routeNodes = [
      [0.14, 0.52],
      [0.3, 0.28],
      [0.36, 0.72],
      [0.52, 0.48],
      [0.68, 0.25],
      [0.78, 0.68],
      [0.9, 0.45],
    ]
    const routes = [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
      [3, 5],
      [4, 6],
      [5, 6],
      [1, 4],
      [2, 5],
    ]
    routes.forEach(([from, to]) => {
      const a = routeNodes[from]
      const b = routeNodes[to]
      addCurve(
        pts,
        edges,
        { x: width * a[0], y: height * a[1] },
        { x: width * (a[0] * 0.7 + b[0] * 0.3), y: height * (a[1] - 0.12) },
        { x: width * (a[0] * 0.26 + b[0] * 0.74), y: height * (b[1] + 0.12) },
        { x: width * b[0], y: height * b[1] },
        18,
      )
    })
    routeNodes.forEach(([x, y], index) => {
      addCircle(pts, edges, width * x, height * y, unit * (index === 3 ? 0.046 : 0.032), 20)
      addCircle(pts, edges, width * x, height * y, unit * (index === 3 ? 0.021 : 0.014), 12)
    })
    addLine(pts, edges, width * 0.14, height * 0.52, width * 0.52, height * 0.48, 22)
    addLine(pts, edges, width * 0.52, height * 0.48, width * 0.9, height * 0.45, 22)
    addLine(pts, edges, width * 0.86, height * 0.43, width * 0.91, height * 0.45, 5)
    addLine(pts, edges, width * 0.86, height * 0.49, width * 0.91, height * 0.45, 5)
  }

  if (kind === 'modular') {
    addRect(pts, edges, width * 0.38, height * 0.36, width * 0.24, height * 0.28, 12)
    const modules = [
      [0.13, 0.16, 0.2, 0.16],
      [0.67, 0.16, 0.2, 0.16],
      [0.13, 0.68, 0.2, 0.16],
      [0.67, 0.68, 0.2, 0.16],
      [0.4, 0.12, 0.2, 0.14],
      [0.4, 0.74, 0.2, 0.14],
    ]
    modules.forEach(([x, y, boxWidth, boxHeight]) => {
      addRect(pts, edges, width * x, height * y, width * boxWidth, height * boxHeight, 8)
      addLine(
        pts,
        edges,
        width * (x + boxWidth / 2),
        height * (y + boxHeight / 2),
        center.x,
        center.y,
        18,
      )
    })
    addCircle(pts, edges, center.x, center.y, unit * 0.055, 22)
  }

  if (kind === 'secure') {
    const shield = [
      { x: width * 0.5, y: height * 0.12 },
      { x: width * 0.76, y: height * 0.22 },
      { x: width * 0.72, y: height * 0.58 },
      { x: width * 0.5, y: height * 0.84 },
      { x: width * 0.28, y: height * 0.58 },
      { x: width * 0.24, y: height * 0.22 },
      { x: width * 0.5, y: height * 0.12 },
    ]
    addPolyline(shield)
    addPolygon(center.x, center.y, unit * 0.18, 6, Math.PI / 6)
    addLine(pts, edges, width * 0.38, height * 0.5, width * 0.47, height * 0.6, 8)
    addLine(pts, edges, width * 0.47, height * 0.6, width * 0.64, height * 0.4, 12)
    addCircle(pts, edges, center.x, center.y, unit * 0.32, 70, Math.PI * 0.12, Math.PI * 1.88)
    const sentinels = [
      [0.32, 0.3],
      [0.72, 0.34],
      [0.68, 0.72],
      [0.3, 0.68],
    ]
    sentinels.forEach(([x, y]) => addCircle(pts, edges, width * x, height * y, unit * 0.019, 12))
  }

  return { pts, edges }
}

function textTargets(text: string, width: number, height: number) {
  const scale = 2
  const offscreen = document.createElement('canvas')
  offscreen.width = Math.max(1, Math.round(width * scale))
  offscreen.height = Math.max(1, Math.round(height * scale))
  const ctx = offscreen.getContext('2d')
  if (!ctx) return []

  const fontSize = Math.min(132, Math.max(78, width * 0.21)) * scale
  ctx.clearRect(0, 0, offscreen.width, offscreen.height)
  ctx.font = `900 ${fontSize}px Inter, Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#000'
  ctx.fillText(text, offscreen.width / 2, offscreen.height * 0.5)

  const data = ctx.getImageData(0, 0, offscreen.width, offscreen.height).data
  const points: Point[] = []
  const gap = width < 450 ? 6 : 5
  const scaledGap = gap * scale
  for (let y = 0; y < offscreen.height; y += scaledGap) {
    for (let x = 0; x < offscreen.width; x += scaledGap) {
      if (data[(y * offscreen.width + x) * 4 + 3] > 45) {
        points.push({ x: x / scale, y: y / scale })
      }
    }
  }
  return points
}

function useHeroCanvases(heroRef: RefObject<HTMLCanvasElement | null>, wordRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const hero = heroRef.current
    const word = wordRef.current
    const heroCtx = hero?.getContext('2d', { alpha: true })
    const wordCtx = word?.getContext('2d', { alpha: true })
    if (!hero || !word || !heroCtx || !wordCtx) return
    const heroCanvas: HTMLCanvasElement = hero
    const wordCanvas: HTMLCanvasElement = word
    const heroContext: CanvasRenderingContext2D = heroCtx
    const wordContext: CanvasRenderingContext2D = wordCtx

    let heroWidth = 1
    let heroHeight = 1
    let wordWidth = 1
    let wordHeight = 1
    let heroParticles: HeroParticle[] = []
    let wordParticles: WordParticle[] = []
    let frame = 0
    const mouse = { x: -9999, y: -9999, wordX: -9999, wordY: -9999, wordActive: false }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function ring(i: number, total: number) {
      const angle = (i / total) * Math.PI * 2
      const centerX = heroWidth * 0.5
      const centerY = heroHeight * 0.39
      const radiusX = Math.min(heroWidth * 0.43, 560)
      const radiusY = Math.min(heroHeight * 0.27, 265)
      const wobble = Math.sin(i * 4.7) * 24 + Math.cos(i * 1.9) * 12
      return {
        x: centerX + Math.cos(angle) * (radiusX + wobble),
        y: centerY + Math.sin(angle) * (radiusY + wobble * 0.75),
        angle,
      }
    }

    function buildHero() {
      const count = heroWidth < 700 ? 820 : 1650
      heroParticles = []
      for (let i = 0; i < count; i += 1) {
        const target = ring(i, count)
        const colorIndex = Math.floor(((target.angle + Math.PI) / (Math.PI * 2)) * palette.length) % palette.length
        heroParticles.push({
          x: target.x + (Math.random() - 0.5) * 280,
          y: target.y + (Math.random() - 0.5) * 160,
          vx: 0,
          vy: 0,
          tx: target.x,
          ty: target.y,
          size: Math.random() * 1.55 + 0.5,
          color: palette[colorIndex],
          phase: Math.random() * Math.PI * 2,
          drift: 0.35 + Math.random() * 0.55,
        })
      }
    }

    function buildWord() {
      const targets = textTargets('VRYX', wordWidth, wordHeight)
      const count = Math.min(wordWidth < 440 ? 720 : 1080, targets.length)
      wordParticles = []
      for (let i = 0; i < count; i += 1) {
        const target = targets[Math.floor((i / count) * targets.length)]
        if (!target) continue
        wordParticles.push({
          x: target.x + (Math.random() - 0.5) * 70,
          y: target.y + (Math.random() - 0.5) * 36,
          vx: 0,
          vy: 0,
          tx: target.x,
          ty: target.y,
          size: Math.random() * 1.18 + 0.72,
          phase: Math.random() * Math.PI * 2,
          color: palette[Math.floor((i / Math.max(count, 1)) * palette.length) % palette.length],
        })
      }
    }

    function resizeHero() {
      const size = fitCanvas(heroCanvas, heroContext)
      heroWidth = size.width
      heroHeight = size.height
      buildHero()
    }

    function resizeWord() {
      const size = fitCanvas(wordCanvas, wordContext)
      wordWidth = size.width
      wordHeight = size.height
      buildWord()
    }

    function drawHeroLines() {
      heroContext.lineWidth = 1
      for (let i = 0; i < heroParticles.length; i += 8) {
        const a = heroParticles[i]
        for (let j = i + 9; j < Math.min(i + 100, heroParticles.length); j += 15) {
          const b = heroParticles[j]
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = dx * dx + dy * dy
          if (dist < 9200) {
            heroContext.globalAlpha = (1 - dist / 9200) * 0.13
            heroContext.strokeStyle = a.color
            heroContext.beginPath()
            heroContext.moveTo(a.x, a.y)
            heroContext.lineTo(b.x, b.y)
            heroContext.stroke()
          }
        }
      }
      heroContext.globalAlpha = 1
    }

    function animate(timestamp: number) {
      heroContext.clearRect(0, 0, heroWidth, heroHeight)
      drawHeroLines()

      for (const particle of heroParticles) {
        const targetX = particle.tx + Math.cos(timestamp * 0.00019 * particle.drift + particle.phase) * 18
        const targetY = particle.ty + Math.sin(timestamp * 0.00022 * particle.drift + particle.phase) * 12
        let ax = (targetX - particle.x) * 0.0072
        let ay = (targetY - particle.y) * 0.0072
        const dx = particle.x - mouse.x
        const dy = particle.y - mouse.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 155) {
          const force = (1 - dist / 155) * 0.62
          ax += (dx / (dist || 1)) * force
          ay += (dy / (dist || 1)) * force
        }
        particle.vx = (particle.vx + ax) * 0.94
        particle.vy = (particle.vy + ay) * 0.94
        particle.x += particle.vx
        particle.y += particle.vy
        heroContext.globalAlpha = 0.72
        heroContext.fillStyle = particle.color
        heroContext.beginPath()
        heroContext.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2)
        heroContext.fill()
      }
      heroContext.globalAlpha = 1

      wordContext.clearRect(0, 0, wordWidth, wordHeight)
      const localX = mouse.wordX
      const localY = mouse.wordY
      const magnetX = mouse.wordActive ? ((localX - wordWidth / 2) / Math.max(wordWidth / 2, 1)) * 6 : 0
      const magnetY = mouse.wordActive ? ((localY - wordHeight / 2) / Math.max(wordHeight / 2, 1)) * 5 : 0

      for (let i = 0; i < wordParticles.length; i += 1) {
        const particle = wordParticles[i]
        const pulse = Math.sin(timestamp * 0.0018 + particle.phase) * 0.5 + 0.5
        let targetX = particle.tx + Math.cos(timestamp * 0.0009 + particle.phase) * 1.7 + magnetX
        let targetY = particle.ty + Math.sin(timestamp * 0.001 + particle.phase) * 1.7 + magnetY
        let repelX = 0
        let repelY = 0

        if (mouse.wordActive) {
          const dx = particle.x - localX
          const dy = particle.y - localY
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 92) {
            const force = (1 - dist / 92) * 1.95
            repelX = (dx / (dist || 1)) * force
            repelY = (dy / (dist || 1)) * force
            targetX += repelX * 18
            targetY += repelY * 12
          }
        }

        const ax = (targetX - particle.x) * 0.044 + repelX
        const ay = (targetY - particle.y) * 0.044 + repelY
        particle.vx = (particle.vx + ax) * 0.84
        particle.vy = (particle.vy + ay) * 0.84
        particle.x += particle.vx
        particle.y += particle.vy
        wordContext.globalAlpha = 0.78 + 0.22 * pulse
        wordContext.fillStyle = particle.color
        wordContext.beginPath()
        wordContext.arc(particle.x, particle.y, particle.size + pulse * 0.28, 0, Math.PI * 2)
        wordContext.fill()

        if (mouse.wordActive && i % 14 === 0) {
          const dx = particle.x - localX
          const dy = particle.y - localY
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 120) {
            wordContext.globalAlpha = (1 - dist / 120) * 0.24
            wordContext.strokeStyle = particle.color
            wordContext.lineWidth = 1
            wordContext.beginPath()
            wordContext.moveTo(localX, localY)
            wordContext.lineTo(particle.x, particle.y)
            wordContext.stroke()
          }
        }
      }
      wordContext.globalAlpha = 1

      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    function onPointerMove(event: PointerEvent) {
      const heroRect = heroCanvas.getBoundingClientRect()
      const wordRect = wordCanvas.getBoundingClientRect()
      mouse.x = event.clientX - heroRect.left
      mouse.y = event.clientY - heroRect.top
      mouse.wordX = event.clientX - wordRect.left
      mouse.wordY = event.clientY - wordRect.top
      mouse.wordActive =
        mouse.wordX >= 0 && mouse.wordX <= wordRect.width && mouse.wordY >= 0 && mouse.wordY <= wordRect.height
    }

    function onPointerLeave() {
      mouse.x = -9999
      mouse.y = -9999
      mouse.wordX = -9999
      mouse.wordY = -9999
      mouse.wordActive = false
    }

    const heroObserver = new ResizeObserver(resizeHero)
    const wordObserver = new ResizeObserver(resizeWord)
    heroObserver.observe(heroCanvas)
    wordObserver.observe(wordCanvas)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave)
    resizeHero()
    resizeWord()
    frame = window.requestAnimationFrame(animate)

    return () => {
      heroObserver.disconnect()
      wordObserver.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [heroRef, wordRef])
}

function useParticleIcon(canvasRef: RefObject<HTMLCanvasElement | null>, kind: FeatureKind, color: string) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !ctx) return
    const canvasEl: HTMLCanvasElement = canvas
    const context: CanvasRenderingContext2D = ctx

    let width = 1
    let height = 1
    let points: Point[] = []
    let edges: Edge[] = []
    let particles: ShapeParticle[] = []
    let hovering = false
    let frame = 0
    const pointer = { x: -9999, y: -9999, active: false }
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function buildParticles() {
      const count = Math.min(kind === 'mesh' ? 480 : 430, Math.max(320, Math.round((width * height) / 650)))
      particles = []
      for (let i = 0; i < count; i += 1) {
        const target = points[i % Math.max(points.length, 1)] || { x: width / 2, y: height / 2 }
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: 0,
          vy: 0,
          base: target,
          phase: Math.random() * Math.PI * 2,
          size: Math.random() * 1.45 + 1.05,
        })
      }
    }

    function resize() {
      const size = fitCanvas(canvasEl, context)
      width = size.width
      height = size.height
      const shape = makeFeatureTargets(kind, width, height)
      points = shape.pts
      edges = shape.edges
      buildParticles()
    }

    function animate(timestamp: number) {
      context.clearRect(0, 0, width, height)
      const active = hovering || pointer.active

      if (edges.length) {
        context.save()
        context.globalAlpha = active ? 0.28 : 0.18
        context.strokeStyle = color
        context.lineCap = 'round'
        context.lineWidth = active ? 1.28 : 0.95
        context.beginPath()
        edges.forEach(([a, b]) => {
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
        })
        context.stroke()
        context.restore()
      }

      const signalEvery = Math.max(3, Math.floor(edges.length / 26))
      for (let i = 0; i < edges.length; i += signalEvery) {
        const [a, b] = edges[i]
        const t = (timestamp * 0.00018 + i * 0.017) % 1
        const x = a.x + (b.x - a.x) * t
        const y = a.y + (b.y - a.y) * t
        context.globalAlpha = active ? 0.74 : 0.5
        context.fillStyle = color
        context.shadowBlur = active ? 11 : 4
        context.shadowColor = color
        context.beginPath()
        context.arc(x, y, active ? 2.15 : 1.6, 0, Math.PI * 2)
        context.fill()
      }
      context.shadowBlur = 0

      for (const particle of particles) {
        const wander = active ? 1.2 : 14
        const stiffness = active ? 0.06 : 0.018
        const targetX = particle.base.x + Math.cos(timestamp * 0.001 + particle.phase) * wander
        const targetY = particle.base.y + Math.sin(timestamp * 0.0012 + particle.phase) * wander
        let ax = (targetX - particle.x) * stiffness
        let ay = (targetY - particle.y) * stiffness
        if (pointer.active) {
          const dx = particle.x - pointer.x
          const dy = particle.y - pointer.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 110) {
            const force = (1 - dist / 110) * 0.82
            ax += (dx / (dist || 1)) * force
            ay += (dy / (dist || 1)) * force
          }
        }
        particle.vx = (particle.vx + ax) * 0.88
        particle.vy = (particle.vy + ay) * 0.88
        particle.x += particle.vx
        particle.y += particle.vy
        context.globalAlpha = active ? 0.98 : 0.72
        context.fillStyle = color
        context.shadowBlur = active ? 6 : 1
        context.shadowColor = color
        context.beginPath()
        context.arc(particle.x, particle.y, particle.size * (active ? 1.08 : 0.94), 0, Math.PI * 2)
        context.fill()
      }
      context.shadowBlur = 0
      context.globalAlpha = 1

      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    const card = canvasEl.closest('.vryx-feature-card')
    const onEnter = () => {
      hovering = true
    }
    const onMove = (event: Event) => {
      const pointerEvent = event as PointerEvent
      const rect = canvasEl.getBoundingClientRect()
      pointer.x = pointerEvent.clientX - rect.left
      pointer.y = pointerEvent.clientY - rect.top
      pointer.active = pointer.x >= 0 && pointer.x <= rect.width && pointer.y >= 0 && pointer.y <= rect.height
    }
    const onLeave = () => {
      hovering = false
      pointer.active = false
      pointer.x = -9999
      pointer.y = -9999
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvasEl)
    card?.addEventListener('pointerenter', onEnter)
    card?.addEventListener('pointermove', onMove, { passive: true })
    card?.addEventListener('pointerleave', onLeave)
    resize()
    frame = window.requestAnimationFrame(animate)

    return () => {
      observer.disconnect()
      card?.removeEventListener('pointerenter', onEnter)
      card?.removeEventListener('pointermove', onMove)
      card?.removeEventListener('pointerleave', onLeave)
      window.cancelAnimationFrame(frame)
    }
  }, [canvasRef, color, kind])
}

function useMapCanvas(canvasRef: RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d', { alpha: true })
    if (!canvas || !ctx) return
    const canvasEl: HTMLCanvasElement = canvas
    const context: CanvasRenderingContext2D = ctx

    type Node = Point & { color: string; radius: number; phase: number }

    let width = 1
    let height = 1
    let nodes: Node[] = []
    let frame = 0
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const mapRatio = 1000 / 520
    const minLat = -58
    const maxLat = 84

    function mapFrame() {
      const canvasRatio = width / Math.max(height, 1)
      if (canvasRatio > mapRatio) {
        const renderedHeight = height
        const renderedWidth = renderedHeight * mapRatio
        return { x: (width - renderedWidth) / 2, y: 0, width: renderedWidth, height: renderedHeight }
      }
      const renderedWidth = width
      const renderedHeight = renderedWidth / mapRatio
      return { x: 0, y: (height - renderedHeight) / 2, width: renderedWidth, height: renderedHeight }
    }

    function project(lon: number, lat: number) {
      const frameBox = mapFrame()
      return {
        x: frameBox.x + ((lon + 180) / 360) * frameBox.width,
        y: frameBox.y + ((35 + ((maxLat - lat) / (maxLat - minLat)) * 430) / 520) * frameBox.height,
      }
    }

    function buildMap() {
      const base: [number, number, string, number][] = [
        [-122.42, 37.77, modelColors.nvidia, 12],
        [-73.57, 45.5, modelColors.qwen, 11],
        [-46.63, -23.55, modelColors.mistral, 9],
        [-0.12, 51.5, modelColors.deepseek, 10],
        [2.35, 48.85, modelColors.microsoft, 12],
        [8.68, 50.11, modelColors.nvidia, 10],
        [55.27, 25.2, modelColors.qwen, 8],
        [77.59, 12.97, modelColors.mistral, 10],
        [103.82, 1.35, modelColors.deepseek, 11],
        [139.69, 35.68, modelColors.llama, 10],
        [151.21, -33.87, modelColors.microsoft, 9],
        [3.38, 6.52, modelColors.nvidia, 8],
        [28.04, -26.2, modelColors.qwen, 8],
      ]
      nodes = base.map(([lon, lat, color, radius]) => ({
        ...project(lon, lat),
        color,
        radius,
        phase: Math.random() * Math.PI * 2,
      }))
    }

    function resize() {
      const size = fitCanvas(canvasEl, context)
      width = size.width
      height = size.height
      buildMap()
    }

    function curve(a: Node, b: Node, color: string, timestamp: number) {
      const pulse = Math.sin(timestamp * 0.0012 + a.phase + b.phase) * 0.5 + 0.5
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2 - Math.min(95, 42 + Math.abs(a.x - b.x) * 0.08)
      context.strokeStyle = color
      context.globalAlpha = 0.12 + 0.2 * pulse
      context.lineCap = 'round'
      context.lineWidth = 1.25
      context.beginPath()
      context.moveTo(a.x, a.y)
      context.quadraticCurveTo(midX, midY, b.x, b.y)
      context.stroke()

      const t = (timestamp * 0.00008 + a.phase) % 1
      const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * midX + t * t * b.x
      const y = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * midY + t * t * b.y
      context.globalAlpha = 0.85
      context.fillStyle = color
      context.beginPath()
      context.arc(x, y, 2.2, 0, Math.PI * 2)
      context.fill()
    }

    function animate(timestamp: number) {
      context.clearRect(0, 0, width, height)
      if (nodes.length) {
        for (let i = 1; i < nodes.length; i += 1) curve(nodes[0], nodes[i], nodes[i].color, timestamp)
        for (let i = 2; i < nodes.length; i += 2) curve(nodes[1], nodes[i], nodes[1].color, timestamp)
        for (let i = 4; i < nodes.length; i += 3) curve(nodes[4], nodes[i], nodes[4].color, timestamp)

        for (const node of nodes) {
          const pulse = Math.sin(timestamp * 0.002 + node.phase) * 0.5 + 0.5
          const glow = context.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 7)
          glow.addColorStop(0, node.color)
          glow.addColorStop(1, 'transparent')
          context.globalAlpha = 0.45
          context.fillStyle = glow
          context.beginPath()
          context.arc(node.x, node.y, node.radius * 7, 0, Math.PI * 2)
          context.fill()
          context.globalAlpha = 1
          context.fillStyle = node.color
          context.shadowBlur = 16
          context.shadowColor = node.color
          context.beginPath()
          context.arc(node.x, node.y, node.radius * 0.48 + pulse * 2, 0, Math.PI * 2)
          context.fill()
          context.shadowBlur = 0
          context.globalAlpha = 0.55
          context.strokeStyle = node.color
          context.lineWidth = 1
          context.beginPath()
          context.arc(node.x, node.y, node.radius + 9 * pulse, 0, Math.PI * 2)
          context.stroke()
        }
      }
      context.globalAlpha = 1
      if (!reducedMotion) frame = window.requestAnimationFrame(animate)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvasEl)
    resize()
    frame = window.requestAnimationFrame(animate)

    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [canvasRef])
}

function IconCanvas({ kind, color }: { kind: FeatureKind; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useParticleIcon(canvasRef, kind, color)
  return <canvas ref={canvasRef} className="vryx-feature-canvas" aria-hidden />
}

function NetworkMap() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useMapCanvas(canvasRef)

  return (
    <div className="vryx-map" aria-label="Carte animée du réseau VRYX">
      <div className="vryx-world" aria-hidden />
      <canvas ref={canvasRef} className="vryx-map-canvas" aria-hidden />
    </div>
  )
}

function ModelLogo({ id }: { id: ModelLogoId }) {
  return (
    <svg className="vryx-model-logo" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {logoGlyphs[id]}
    </svg>
  )
}

function AppleLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 25" fill="currentColor" aria-hidden>
      <path d="M16.37 1.43c0 1.1-.45 2.12-1.22 2.9-.83.84-1.93 1.35-3 1.26-.13-1.04.39-2.16 1.16-2.96.82-.84 2.1-1.48 3.06-1.2Zm3.42 16.67c-.6 1.38-.9 2-1.67 3.22-1.08 1.66-2.6 3.73-4.49 3.75-1.68.02-2.11-1.09-4.39-1.08-2.28.01-2.76 1.1-4.44 1.08-1.89-.02-3.33-1.88-4.41-3.54-3-4.6-3.32-10-.02-12.88 1.17-1.02 2.75-1.62 4.23-1.64 1.66-.03 3.23 1.12 4.25 1.12 1.02 0 2.94-1.38 4.96-1.18.84.03 3.22.34 4.75 2.58-4.18 2.3-3.5 8.21 1.23 8.57Z" />
    </svg>
  )
}

function WindowsLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 4.8 10.8 3.7v7.55H3V4.8Zm9-1.25L21 2.25v9h-9V3.55ZM3 12.75h7.8v7.55L3 19.2v-6.45Zm9 0h9v9l-9-1.25v-7.75Z" />
    </svg>
  )
}

type DownloadTarget = {
  href: string
  label: string
  platform: 'macos' | 'windows'
}

const macDownload: DownloadTarget = {
  href: '/downloads/Vryx-Worker-latest-mac.zip',
  label: 'Télécharger pour macOS',
  platform: 'macos',
}

const windowsDownload: DownloadTarget = {
  href: '/downloads/Vryx-Worker-Setup-latest-x64.exe',
  label: 'Télécharger pour Windows',
  platform: 'windows',
}

function resolveDownloadTarget(): DownloadTarget {
  if (typeof navigator === 'undefined') return macDownload
  const userAgent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  return userAgent.includes('windows') || userAgent.includes('win32') || userAgent.includes('win64')
    ? windowsDownload
    : macDownload
}

function useDownloadTarget() {
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget>(macDownload)

  useEffect(() => {
    setDownloadTarget(resolveDownloadTarget())
  }, [])

  return downloadTarget
}

export function VryxLandingExperience() {
  const heroCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const wordCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const downloadTarget = useDownloadTarget()
  useHeroCanvases(heroCanvasRef, wordCanvasRef)

  return (
    <div className="vryx-landing">
      <section className="vryx-hero" aria-labelledby="hero-heading">
        <canvas ref={heroCanvasRef} className="vryx-hero-canvas" aria-hidden />

        <div className="vryx-hero-core">
          <div className="vryx-word" aria-hidden>
            <canvas ref={wordCanvasRef} />
          </div>
          <h1 id="hero-heading" className="sr-only">
            VRYX, réseau P2P pour exécuter l’IA sur des GPU distribués
          </h1>
          <p className="vryx-hero-copy">
            Le calcul IA devient fluide, mondial et programmable.
          </p>
          <div className="vryx-actions">
            <a className="vryx-button vryx-button-primary" href={downloadTarget.href}>
              {downloadTarget.platform === 'windows' ? (
                <WindowsLogo className="vryx-button-icon" />
              ) : (
                <AppleLogo className="vryx-button-icon" />
              )}
              {downloadTarget.label}
              <span aria-hidden>→</span>
            </a>
          </div>
        </div>
      </section>

      <section className="vryx-stats-wrap" aria-label="Indicateurs réseau">
        <div className="vryx-stats">
          {stats.map((stat) => (
            <article className="vryx-stat" key={stat.label}>
              <div>
                <span className="vryx-stat-pin" style={{ '--pin': stat.color } as CSSProperties} aria-hidden />
                <strong>{stat.value}</strong>
              </div>
              <p>{stat.label}</p>
            </article>
          ))}
        </div>
      </section>

      <main className="vryx-landing-main">
        <section id="product" className="vryx-product" aria-labelledby="product-heading">
          <div className="vryx-section-heading">
            <p>Conçu pour l’échelle</p>
            <h2 id="product-heading">Une nouvelle façon de faire tourner l’IA</h2>
          </div>
          <div className="vryx-feature-grid">
            {features.map((feature) => (
              <article className="vryx-feature-card" key={feature.kind}>
                <div className="vryx-feature-stage">
                  <IconCanvas kind={feature.kind} color={feature.color} />
                </div>
                <div className="vryx-feature-copy">
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
                <div className="vryx-card-wave" style={{ '--wave': feature.color } as CSSProperties} aria-hidden />
              </article>
            ))}
          </div>
        </section>

        <section id="network" className="vryx-network" aria-labelledby="network-heading">
          <div className="vryx-network-copy">
            <p className="vryx-mini-title">La puissance du P2P</p>
            <h2 id="network-heading">Le monde devient ta puissance de calcul.</h2>
            <p>
              VRYX rassemble des GPU dormants, vérifie leur disponibilité et route les charges IA vers la bonne
              capacité au bon moment.
            </p>
            <Link className="vryx-button vryx-button-secondary" to="/network">
              Explorer le réseau
              <span aria-hidden>→</span>
            </Link>
            <div className="vryx-legend" aria-label="Légende des nœuds réseau">
              <span>
                <i style={{ '--legend': modelColors.qwen } as CSSProperties} aria-hidden />
                Nœud actif
              </span>
              <span>
                <i style={{ '--legend': modelColors.mistral } as CSSProperties} aria-hidden />
                Haute capacité
              </span>
              <span>
                <i style={{ '--legend': modelColors.deepseek } as CSSProperties} aria-hidden />
                Nœud périphérique
              </span>
              <span>
                <i style={{ '--legend': modelColors.nvidia } as CSSProperties} aria-hidden />
                En connexion
              </span>
            </div>
          </div>
          <NetworkMap />
        </section>

        <section id="workers" className="vryx-worker-strip" aria-labelledby="workers-home-heading">
          <div>
            <p className="vryx-mini-title">Nœuds</p>
            <h2 id="workers-home-heading">Chaque GPU peut rejoindre le réseau.</h2>
          </div>
          <p>
            Les nœuds apportent de la capacité, VRYX orchestre la qualité de service, la sécurité d’exécution et la
            mesure de contribution.
          </p>
          <Link className="vryx-button vryx-button-primary" to="/workers">
            Devenir nœud
            <span aria-hidden>→</span>
          </Link>
        </section>

        <section className="vryx-logo-cloud" aria-labelledby="logo-cloud-heading">
          <h2 id="logo-cloud-heading">Compatible avec les piles IA modernes</h2>
          <div className="vryx-logo-row">
            {logos.map((logo, index) => (
              <div
                className="vryx-logo-tile"
                key={`${logo.id}-${index}`}
                role="img"
                aria-label={logo.alt}
                style={
                  {
                    '--logo-delay': `${index * 0.16}s`,
                    '--logo-depth': `${Math.sin(index * 0.9) * 0.22 + 1}`,
                    '--logo-y': `${Math.sin(index * 0.82) * 0.75}rem`,
                  } as CSSProperties
                }
              >
                <ModelLogo id={logo.id} />
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
