import type { ReactNode } from 'react'
import type { AppointmentCard, ContactCard, DistListCard, JournalCard, TaskCard } from '../types'
import { formatDate } from '../lib/format'

function dateOnly(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** A safe href for a website field. Only web addresses are linked, so a
 *  record carrying something like a javascript: URL cannot be clicked. */
function withProtocol(url: string): string {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return '' // some other scheme: not linkable
  return `https://${trimmed}`
}

function timeRange(start: number | null, end: number | null, allDay: boolean): string {
  if (start == null) return ''
  if (allDay) {
    const s = dateOnly(start)
    const e = end != null ? dateOnly(end) : ''
    return e && e !== s ? `${s} to ${e}` : `${s} (all day)`
  }
  const s = formatDate(start)
  return end != null ? `${s} to ${formatDate(end)}` : s
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-slate-200">{children}</span>
    </div>
  )
}

/** A contact item (IPM.Contact) laid out in the content area, with its note if
 *  present. The contact's name is shown once, by the view header above. */
export function ContactCardView({
  contact,
  notes,
}: {
  contact: ContactCard
  notes?: string | null
}) {
  const subtitle = [contact.jobTitle, contact.company].filter(Boolean).join(', ')
  return (
    <div className="px-6 py-5">
      {subtitle && <p className="text-sm text-slate-400">{subtitle}</p>}
      <div className="mt-2 max-w-3xl divide-y divide-slate-800/70">
        {contact.emails.map((e, i) => (
          <Row key={`e${i}`} label={i === 0 ? 'Email' : e.label}>
            <a href={`mailto:${e.address}`} className="text-sky-400 hover:underline">
              {e.address}
            </a>
          </Row>
        ))}
        {contact.phones.map((p, i) => (
          <Row key={`p${i}`} label={p.label}>
            {p.value}
          </Row>
        ))}
        {contact.im && <Row label="IM">{contact.im}</Row>}
        {contact.department && <Row label="Department">{contact.department}</Row>}
        {contact.addresses.map((a, i) => (
          <Row key={`a${i}`} label={`${a.label} address`}>
            <span className="whitespace-pre-wrap">{a.value}</span>
          </Row>
        ))}
        {contact.website && (
          <Row label="Website">
            <a
              href={withProtocol(contact.website)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sky-400 hover:underline"
            >
              {contact.website}
            </a>
          </Row>
        )}
        {contact.birthday != null && <Row label="Birthday">{dateOnly(contact.birthday)}</Row>}
      </div>
      {notes && notes.trim() && (
        <div className="mt-5 max-w-3xl border-t border-slate-800/70 pt-3">
          <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Notes</div>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{notes}</p>
        </div>
      )}
    </div>
  )
}

/** Appointment/meeting (IPM.Appointment) metadata, shown above the body (notes). */
export function AppointmentCardView({ appointment }: { appointment: AppointmentCard }) {
  const when = timeRange(appointment.start, appointment.end, appointment.allDay)
  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-6 py-4">
      <div className="space-y-0.5">
        {when && <Row label="When">{when}</Row>}
        {appointment.location && <Row label="Where">{appointment.location}</Row>}
        {appointment.organizer && <Row label="Organizer">{appointment.organizer}</Row>}
        {appointment.requiredAttendees && (
          <Row label="Required">{appointment.requiredAttendees}</Row>
        )}
        {appointment.optionalAttendees && (
          <Row label="Optional">{appointment.optionalAttendees}</Row>
        )}
        {appointment.recurrence && <Row label="Recurrence">{appointment.recurrence}</Row>}
      </div>
    </div>
  )
}

/** A distribution list / contact group (IPM.DistList) laid out in the content
 *  area. The list's name is shown once, by the view header above. */
export function DistListCardView({
  distlist,
  notes,
}: {
  distlist: DistListCard
  notes?: string | null
}) {
  const n = distlist.members.length
  return (
    <div className="px-6 py-5">
      <p className="text-sm text-slate-400">
        Distribution list{n > 0 ? `, ${n} member${n === 1 ? '' : 's'}` : ''}
      </p>
      {n > 0 && (
        <ul className="mt-2 max-w-3xl divide-y divide-slate-800/70">
          {distlist.members.map((mem, i) => (
            <li key={i} className="flex flex-col py-2">
              {mem.name && <span className="text-sm text-slate-200">{mem.name}</span>}
              {mem.email && (
                <a href={`mailto:${mem.email}`} className="text-sm text-sky-400 hover:underline">
                  {mem.email}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {notes && notes.trim() && (
        <div className="mt-5 max-w-3xl border-t border-slate-800/70 pt-3">
          <div className="mb-1 text-xs uppercase tracking-wide text-slate-500">Notes</div>
          <p className="whitespace-pre-wrap text-sm text-slate-300">{notes}</p>
        </div>
      )}
    </div>
  )
}

/** A task (IPM.Task) shown as a card; its description renders below. */
export function TaskCardView({ task }: { task: TaskCard }) {
  const status =
    task.status +
    (task.percentComplete > 0 && task.percentComplete < 100 ? ` (${task.percentComplete}%)` : '')
  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-6 py-4">
      <div className="space-y-0.5">
        {task.status && <Row label="Status">{status}</Row>}
        {task.dueDate != null && <Row label="Due">{dateOnly(task.dueDate)}</Row>}
        {task.startDate != null && <Row label="Start">{dateOnly(task.startDate)}</Row>}
        {task.dateCompleted != null && <Row label="Completed">{dateOnly(task.dateCompleted)}</Row>}
        {task.owner && <Row label="Owner">{task.owner}</Row>}
        {task.priority && <Row label="Priority">{task.priority === 'high' ? 'High' : 'Low'}</Row>}
      </div>
    </div>
  )
}

/** A journal entry (IPM.Activity) shown as a card; its body renders below. */
export function JournalCardView({ journal }: { journal: JournalCard }) {
  return (
    <div className="border-b border-slate-800 bg-slate-900/40 px-6 py-4">
      <div className="space-y-0.5">
        {journal.entryType && <Row label="Type">{journal.entryType}</Row>}
        {journal.start != null && <Row label="When">{formatDate(journal.start)}</Row>}
        {journal.durationMinutes > 0 && <Row label="Duration">{journal.durationMinutes} min</Row>}
      </div>
    </div>
  )
}
