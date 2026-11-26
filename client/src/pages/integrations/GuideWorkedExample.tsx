import { useId, useState } from "react";
import { ArrowDownToLine, ChartNoAxesColumnIncreasing, ClipboardCheck, Coins, MonitorSmartphone, Send, type LucideIcon } from "lucide-react";
import { guideExamples } from "./guides/visual-examples";
import "./guide-worked-example.css";

const factIcons: Record<keyof typeof guideExamples, [LucideIcon, LucideIcon]> = {
  transfer: [Send, MonitorSmartphone],
  "set-rate": [ChartNoAxesColumnIncreasing, ClipboardCheck],
  accept: [Coins, ArrowDownToLine],
};

export function GuideWorkedExample({ flow }: { flow: keyof typeof guideExamples }) {
  const example = guideExamples[flow];
  const group = useId();
  const [selected, setSelected] = useState(0);
  const { facts, guidance, fill } = example.cases[selected];
  return (
    <figure className="si-worked-example" aria-labelledby={group + "-title"}>
      <figcaption>
        <h3 id={group + "-title"}>{example.title}</h3>
        <p>{example.context}</p>
      </figcaption>
      <fieldset className="si-example-choices">
        <legend className="sr-only">{example.title}</legend>
        {example.cases.map(({ label }, i) => (
          <label key={label}>
            <input className="sr-only" type="radio" name={group} value={label}
              checked={selected === i} onChange={() => setSelected(i)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <div className="si-example-result" aria-live="polite" aria-atomic="true">
        {fill && (
          <div className="si-example-fill">
            <label htmlFor={group + "-fill"}>Matched amount</label>
            <strong>{fill.matched} / {fill.total} {fill.unit}</strong>
            <meter id={group + "-fill"} min={0} max={fill.total} value={fill.matched}
              aria-valuetext={`${fill.matched} of ${fill.total} ${fill.unit} matched`} />
          </div>
        )}
        <dl className="si-example-facts">
          {facts.map(({ label, value }, i) => {
            const Icon = factIcons[flow][i];
            return (
              <div key={label}>
                <dt><Icon size={15} aria-hidden="true" />{label}</dt>
                <dd>{value}</dd>
              </div>
            );
          })}
        </dl>
        <p>{guidance}</p>
      </div>
    </figure>
  );
}
