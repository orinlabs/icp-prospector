const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

function buildUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`
  if (apiBase) return `${apiBase}${p}`
  return `/api${p}`
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text || res.statusText)
  }
  return text ? (JSON.parse(text) as T) : ({} as T)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(buildUrl(path))
  return parseJson<T>(res)
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(buildUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return parseJson<T>(res)
}

export type Campaign = {
  id: string
  name: string
  icpDocument: string
  targetCount: number
  status: string
  createdAt: string
  updatedAt: string
}

export type Company = {
  id: string
  name: string
  domain: string | null
  website: string | null
  industry: string | null
  employeeRange: string | null
  hqLocation: string | null
  createdAt: string
}

export type Person = {
  id: string
  companyId: string | null
  fullName: string | null
  email: string | null
  linkedinUrl: string | null
  title: string | null
  lifecycleStatus: string
  createdAt: string
}
