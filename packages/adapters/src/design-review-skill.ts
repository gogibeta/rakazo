/**
 * The Design Review skill (EGM-2): the drafting bot writes a short design, then
 * two or three clean-room reviewers (EGM-1's `fresh_context`) tear into it
 * before anything is built. It lives in its own module rather than inlined in
 * `builtin-skills.ts` because that file sits at the ceiling of what can be
 * pushed through the deployment's vault; keeping this definition separate means
 * the next skill does not hit the same wall.
 *
 * Lenses adapted from Every Gate Matters (Apache 2.0).
 */
export const DESIGN_REVIEW_SKILL: { name: string; description: string; body: string } = {
  name: "Design Review",
  description: "Get a plan reviewed in a clean room before you build it",
  body: `Design first, build second. When the wrong approach would waste work, write a short design, have reviewers who see only it critique it, and build once the owner approves.

A task is large when it changes architecture, touches several files, adds a dependency or migration, or the owner says so. Small mechanical work does not need this; reviewing everything costs too.

1. Write the design: the problem, what done looks like, the approach you chose and the one you rejected, the risks, open questions, files you expect to touch. Keep it short. Save it with write_file so reviewers get it verbatim.
2. Spawn two or three reviewers with run_subagent, one lens each, in a clean room: pass fresh_context: true, put the design in document. A reviewer that inherits this thread watched you decide, and will agree with you.
 - Design critic: the right problem? The smallest approach? Hunt unstated assumptions.
 - Structural: does it fit the codebase? Boundaries, ownership, duplication, breakage.
 - Readiness: could anyone build it from the document alone? Missing steps, undefined terms, untestable claims.
 Each reports findings only, changes nothing.
3. Merge the findings: group by severity, keep the lens that found each item, drop duplicates; where reviewers disagree, say so and recommend.
4. Stop for approval. Present the design and findings with ask_user and wait: the owner approves, edits or rejects. Never treat silence, a yes to another task, or your own confidence as approval. If the owner edits, the edit wins.
5. Build only after approval, and build the approved design. If building proves it wrong, stop and say so.

Lenses adapted from Every Gate Matters (Apache 2.0).`,
};
