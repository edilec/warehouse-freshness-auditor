import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseInstant } from '../src/time.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = dirname(HERE)
export const BIN = join(ROOT, 'bin', 'warehouse-freshness-auditor.mjs')

const trash = []

export async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'wfa-'))
  trash.push(directory)
  return directory
}

export async function cleanup() {
  while (trash.length > 0) {
    await rm(trash.pop(), { recursive: true, force: true })
  }
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

/** Milliseconds for an instant literal, so tests read as instants and not numbers. */
export function ms(text) {
  const instant = parseInstant(text)
  if (!instant.ok) throw new Error(`the test wrote an instant this tool does not read: ${text}`)
  return instant.ms
}

export const BUSINESS_DAYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])

export function policy({ tables, calendar, limits }) {
  const document = { schemaVersion: '1', tables }
  if (calendar !== undefined) document.calendar = calendar
  if (limits !== undefined) document.limits = limits
  return document
}

export function snapshot({ generatedAt, tables, runs }) {
  const document = { schemaVersion: '1', generatedAt, tables }
  if (runs !== undefined) document.runs = runs
  return document
}

/** Write a policy and a snapshot into a fresh workspace and return their paths. */
export async function project(policyDocument, snapshotDocument) {
  const directory = await workspace()
  const policyPath = join(directory, 'freshness.policy.json')
  const snapshotPath = join(directory, 'snapshot.json')
  await writeJson(policyPath, policyDocument)
  if (snapshotDocument !== undefined) await writeJson(snapshotPath, snapshotDocument)
  return { directory, policyPath, snapshotPath }
}

export function run(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { ...options }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}
