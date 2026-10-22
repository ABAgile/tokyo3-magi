# magi

Multi-model agent loops that iterate on a codebase until the work converges.

In Evangelion, MAGI is three supercomputers that check one another before anything is decided. magi applies
the same idea to coding agents: different models take turns reviewing, fixing, and checking one another's
work, round after round, until nothing is left to change. A human steps in only for decisions the agents
should not make on their own.

The first workflow, **code-review**, reviews a repository exhaustively, fixes what it finds, extracts shared
abstractions from repeated code, and leaves a clean, reviewable branch.

## Design

magi has three layers, and each can change without the others:

```
          ┌──────────────────────────────────────────────┐
          │ Workflows   what to do and when to stop      │  code-review, ... (yours next)
          ├──────────────────────────────────────────────┤
          │ Engine      runs, steps, agents, humans      │  resumable, model-agnostic
          ├──────────────────────────────────────────────┤
          │ Drivers     how to talk to an agent harness  │  pi (SDK), pi (CLI), ...
          └──────────────────────────────────────────────┘
```

- **Workflow.** A loop written as a plain script: a sequence of steps, and a condition that says the work has
  converged. It holds no agent plumbing or recovery logic.
- **Engine.** Gives every workflow the same services: steps that run exactly once, agent calls with checked
  results, questions for a human, an isolated workspace, and reports. It knows nothing about any one
  workflow.
- **Driver.** Adapts one agent harness. It starts a conversation, continues it, and reports cost and the
  files the agent read. Any harness that can do that can drive any workflow.

### How agents are used

Every agent call follows the same contract, whichever workflow or harness is involved:

1. **A task with a result contract.** The agent gets a prompt and the exact shape of the result it must
   hand back, such as a list of findings or a fix outcome.
2. **Checked, then repaired in the same conversation.** A result with the wrong shape, or one the workflow
   rejects (for example, a fix that breaks the build), goes back to the same agent with the reason, so it
   repairs with full context.
3. **Failover to another model.** If an agent fails or cannot produce an acceptable result, its changes
   are discarded and the next model starts fresh, told why the previous one failed.
4. **Rotation for independent judgment.** Each role works through a list of models in turn, and work is
   not checked by the model that produced it. A fix comes from a different model than the one that found
   the problem.
5. **Read-only means read-only.** Agents that only look (reviewers, scanners) cannot leave changes behind.
   Anything they modify is undone.

### How humans are involved

Agents settle what the code and the project's documentation can settle. When a decision needs judgment,
such as breaking a public API or choosing between real tradeoffs, the loop does not guess. It raises a
**question** with the context, the options, their consequences, and a recommendation, then carries on with
other work. You answer whenever you like:

- pick an option, or give your own instruction, and the next round carries it out;
- skip it, and later runs on that repository are told not to raise it again.

You can also send a **request**, a change you want made, which the loop handles like any other task.

### How a loop runs

Every workflow follows the same outer shape:

```
            ┌───────────────────────────────────────────────┐
            ▼                                               │
   take in human answers and requests                       │
            ▼                                               │
   act on open work            (agents change the code)     │
            ▼                                               │
   assess the result           (agents look for more work)  │
            ▼                                               │
   converged? ── no, and under the round limit ─────────────┘
            │
           yes, or the limit is reached
            ▼
   finish                      (e.g. organize commits)
```

A run is **resumable at any point**. Each step is recorded once it completes. After an interruption, a
crash, or new answers, the loop picks up where it left off, and work an interrupted step left half done is
discarded and redone.

A run is **isolated**. It works on its own branch, in its own checkout of the target repository, and the
original checkout is never touched. Nothing is pushed; merging the branch is your call.

## The code-review workflow

Each round has two parts:

1. **Fix.** Every open finding is handled on its own, one after another. A fixer verifies it, then fixes,
   rejects, marks it a duplicate, or defers it to a human. Fixers start with the cheapest model and move up to
   a stronger one only when an attempt fails. A fix counts only if the project's check passes (for Go: build,
   vet, test). Each fix becomes one commit.
2. **Review.** Running in parallel:
   - **Reviewers** read files no one has read yet, plus everything that changed since the last review.
     Every defect is reported with every place it occurs, so it is fixed everywhere at once.
   - **A pattern scanner** looks across the whole project for repeated handling that should go through one
     shared interface. Behavior-preserving consolidations go to a fixer; ones that need a judgment become
     questions.

A round with nothing new, nothing open, and every file read is **clean**. A clean round triggers the **audit**:
the whole project is read once more, in parallel slices, by the audit models, with stricter rules about
evidence. If the audit finds something, those findings are fixed and reviewed as usual, and the loop does not
audit again. If the audit cannot read every file, the run ends as **unaudited** rather than converged.

The loop stops at the round limit too; findings from the last review are then still fixed, but not reviewed
again. Finally, a cheap organizer model groups the per-finding commits into a history a reviewer can follow,
and the original history is kept alongside. Setting `audits` to 0, or passing `--audits 0`, turns the audit
off.

## Getting started

Requirements:

- Node.js 24 or later, and git.
- [pi](https://github.com/earendil-works/pi) set up with credentials for the models you want (`~/.pi/agent`).
  magi uses the same settings, credentials, skills, and project instructions (`AGENTS.md`) as pi.

Run it from anywhere. Dependencies are installed on first use:

```sh
/tokyo3/proj/abagile/magi/bin/magi help
ln -s /tokyo3/proj/abagile/magi/bin/magi ~/.local/bin/magi   # optional
```

The target repository must have no uncommitted changes, because a run starts from its current commit.

Defaults, such as where runs are kept or which models fill each role, can be set once in `config.json`
next to this README. The file is optional; without it, the built-in defaults apply. To create it with the
built-in defaults and then edit it:

```sh
magi config init      # writes config.json (refuses to overwrite an existing one)
magi config           # shows every value in effect, and whether it comes from config.json or the built-in
```

A file that sets only a few values is enough, for example:

```json
{
  "driver": "pi-sdk",
  "runsDir": "/tokyo3/proj/abagile/magi/runs",
  "code-review": {
    "maxRounds": 8,
    "models": { "review": ["openai-codex/gpt-6.1-sol:high", "anthropic/claude-opus-5-5:high"] }
  }
}
```

Settings are read when a run starts and kept with that run, so editing the file does not change a run
already in progress; `magi resume` takes its settings from the run, with flags on top. `magi config` reports
misspelled keys and unknown model roles, which would otherwise be ignored. The check command is not written
by `magi config init`: its default depends on each target repository.

Each run keeps its working copy, progress, and reports in its own directory,
`<runsDir>/<repo>/<workflow>-<timestamp>/`, outside the target repository. Pick a `runsDir` whose
path stays the same in every environment you run magi from, such as your dev container. `--runs-dir` and
`$MAGI_RUNS` override it for a single run or shell.

## Operating a run

```sh
magi run code-review ./vault              # start; prints the run directory
magi status <run dir>                     # where it stands: rounds, findings, cost
magi decide <run dir>                     # answer open questions, one by one
magi request <run dir> "make X do Y"      # ask for a change
magi resume <run dir>                     # continue: after answers, requests, or an interruption
magi resume <run dir> --max-rounds 10     # allow more review rounds
magi list [./vault]                       # all runs, or those on one repository
magi config                               # the settings in effect, and where each comes from
magi clean <run dir>                      # remove a run; its branch too, once merged
```

A `<run dir>` can be given as a path, or by the short name `magi list` shows, such as
`vault/code-review-20261021-072415`.

A typical cycle:

1. **Start** a run and let it work. Progress is printed as it goes.
2. **Read** `summary.md` in the run directory: what was found, what was fixed, what it cost.
3. **Decide** on whatever is in `outstanding.md`, or leave it for later.
4. **Resume.** The loop applies your answers, reviews the result, and converges again.
5. **Review and merge** the run's branch (`magi-<workflow>-<timestamp>` in the target repository) the way
   you would any other branch.
6. **Clean up** with `magi clean`. A run whose work is not merged keeps its branch, unless you add
   `--force`.

Exit status: `0` converged, `1` stopped at the round limit or unaudited, `2` error, `130` interrupted. Ctrl-C is
safe: resume later.

`magi help code-review` lists the workflow's options: round limit, number of reviewers, the check command,
review focus, model lists per role, and more.

## Extending magi

### A new workflow

A workflow is any loop that can be stated as "act, assess, repeat until there is nothing left to do". Some
examples that fit:

- keep dependencies current, fixing what each upgrade breaks;
- raise test coverage until every package meets a bar;
- bring documentation back in line with the code;
- carry out a migration (an API, a library, a pattern) across a codebase.

To add one, you describe only what is specific to it:

| You define | For example, in code-review |
|---|---|
| **Settings** and their defaults | round limit, models per role, check command |
| **Roles**, their prompts, and the result each must return | reviewer → findings; fixer → outcome and commit message |
| **What it remembers** between rounds | findings and their status, files already read |
| **The loop**: which steps, in what order, and when it has converged | fix open findings, then review; stop when a round finds nothing |
| **What goes in the summary** | rounds, findings, coverage |

The engine supplies everything else: resuming, model rotation and failover, checked results, the human
question-and-answer cycle, the isolated branch, and the commands above. Building blocks from code-review,
such as file coverage tracking and commit organization, can be reused.

### A new agent harness

To use another harness, such as Claude Code or Codex, add a driver. It needs to:

- start a conversation with a prompt, a model, and a working directory, with or without permission to edit;
- give the agent a way to hand back a structured result;
- continue the same conversation with a follow-up message;
- report the cost and the files the agent read.

Every workflow can then run on it with `--driver <name>`.
