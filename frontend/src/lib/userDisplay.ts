export function emailToInitials(email: string): string {
  const local = email.split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    const a = parts[0]?.[0] ?? ''
    const b = parts[1]?.[0] ?? ''
    const s = (a + b).toUpperCase()
    return s || '??'
  }
  const s = local.slice(0, 2).toUpperCase()
  return s || '??'
}
