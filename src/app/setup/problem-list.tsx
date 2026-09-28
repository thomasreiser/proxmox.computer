import type { StepProblem } from "./step-checks";
import type { WizardStepId } from "./wizard-state";

/**
 * What's still stopping a step, listed where the visitor just tried to
 * continue — each entry names the node and the field, so it can be found
 * in a long form without hunting for the red.
 */
// `step` is the step the visitor is on — anything from another step is
// labeled with it, since it can't be fixed on this page.
export function ProblemList({ problems, step }: { problems: StepProblem[]; step: WizardStepId }) {
  if (problems.length === 0) return null;
  const earlier = problems.filter((p) => p.step !== step);
  return (
    <div className="pc-callout pc-callout--danger" role="alert">
      <span className="code pc-callout__glyph">✗</span>
      <div className="pc-callout__body">
        <p className="body pc-callout__title">
          {problems.length === 1 ? "1 thing" : `${problems.length} things`} to fix before continuing
        </p>
        {earlier.length > 0 && (
          <p className="body-sm pc-callout__text text-ink-muted">
            some are in an earlier step — go back to fix them.
          </p>
        )}
        <ul className="pc-problems">
          {problems.map((p, i) => (
            <li key={i} className="body-sm pc-problems__item">
              <span className="pc-problems__where">
                {p.step !== step ? `step ${p.step} · ` : ""}
                {p.where}
              </span>
              <span className="pc-problems__field">{p.field}</span>
              <span className="pc-problems__message">{p.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
