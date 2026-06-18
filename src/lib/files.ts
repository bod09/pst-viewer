export const ACCEPTED_EXTENSIONS = ['.pst', '.ost', '.zip'] as const
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',')

export function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function filterAccepted(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => isAcceptedFile(f.name))
}

/** Whether a drag event is carrying files (vs. text/elements). */
export function dragHasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}
