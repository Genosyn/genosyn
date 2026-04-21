import fs from "node:fs";

/**
 * Starter markdown for Soul, Skills, and Routines.
 *
 * These bodies live in the DB (see `AIEmployee.soulBody`, `Skill.body`,
 * `Routine.body`). The generators live here so both the create-flow routes
 * and the template materializer share one source of truth for what a fresh
 * doc looks like. Editing them does not require a migration.
 */

export function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function soulTemplate(name: string, role: string): string {
  return `# ${name}'s Soul

> This is the constitution of **${name}** (${role}). Fill it in like you'd brief
> a brand-new teammate on their first day. Editable from the Soul tab — the
> DB is the source of truth.

## Who you are
A short paragraph in the first person about who ${name} is, what ${name} cares
about, and how ${name} sees the company.

## How you work
- What's the tone of your writing?
- What decisions do you make without asking?
- What decisions do you always escalate to a human?

## What you refuse to do
- A list of hard "no" behaviors.

## Reference material
- Links to docs, style guides, competitor notes.
`;
}

export function skillTemplate(name: string): string {
  return `# ${name}

One sentence about what this Skill does.

## When to use it
Describe the trigger — when should ${name} be reached for?

## Steps
1. First step.
2. Second step.
3. Third step.

## Notes
Anything a future AI employee should know before running this Skill.
`;
}

export function routineTemplate(name: string, cronExpr: string): string {
  return `# ${name}

**Schedule:** \`${cronExpr}\`

## Goal
What this routine is meant to achieve on each run.

## Inputs
What context or data should be pulled in at run time.

## Output
Where the output goes — a document, a channel, a report.

## Notes
Anything the runner should keep in mind.
`;
}
