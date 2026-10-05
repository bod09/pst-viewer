import type { MessageContent } from '../../src/types'

/** A message as the worker hands it to the page, with only what a test cares about filled in. */
export function messageContent(overrides: Partial<MessageContent> = {}): MessageContent {
  return {
    itemKind: 'email',
    subject: 'Subject',
    fromName: '',
    fromEmail: '',
    to: [],
    cc: [],
    bcc: [],
    date: null,
    html: null,
    text: 'Body',
    inlineImages: [],
    attachments: [],
    headers: '',
    categories: [],
    importance: null,
    sensitivity: null,
    followUp: null,
    ...overrides,
  }
}
