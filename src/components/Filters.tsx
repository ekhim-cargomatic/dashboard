/**
 * The filter controls, rendered inline in the top bar.
 *
 * Every control narrows the run set that all the charts read from, so the whole
 * page always describes one coherent slice. They live in one row rather than
 * per-chart, and there is no separate filter card — with the grouping toggle gone
 * there are few enough controls to sit beside the title.
 */

import type { Filters as FilterState } from '../lib/aggregate';

interface Facet {
  value: string;
  label: string;
  count: number;
}

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  facets: {
    workflows: Facet[];
    environments: Facet[];
    branches: Facet[];
  };
}

const RANGES = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 0, label: 'All time' },
];

function Select({
  label,
  value,
  options,
  onChange,
  allLabel,
  alwaysShow = false,
}: {
  label: string;
  value: string;
  options: Facet[];
  onChange: (next: string) => void;
  allLabel: string;
  /** Keep the control even with one option — true for primary navigation. */
  alwaysShow?: boolean;
}) {
  // A dropdown whose only choice is "all" is dead UI: environment and branch come
  // from an environment.properties CI does not currently write, so they are usually
  // empty. Suite is exempt — it is how you move between smoke, regression and the
  // rest, and it needs to be visible (and to show what exists) even on day one
  // when only one suite has published.
  if (!alwaysShow && options.length < 2 && !value) return null;

  return (
    <label className="control">
      <span className="control-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </label>
  );
}

export function Filters({ filters, onChange, facets }: Props) {
  return (
    <>
      <Select
        label="Suite"
        value={filters.workflow}
        options={facets.workflows}
        onChange={(workflow) => onChange({ ...filters, workflow })}
        allLabel="All suites"
        alwaysShow
      />
      <Select
        label="Environment"
        value={filters.environment}
        options={facets.environments}
        onChange={(environment) => onChange({ ...filters, environment })}
        allLabel="All environments"
      />
      <Select
        label="Branch"
        value={filters.branch}
        options={facets.branches}
        onChange={(branch) => onChange({ ...filters, branch })}
        allLabel="All branches"
      />

      <label className="control">
        <span className="control-label">Range</span>
        <select
          value={filters.days}
          onChange={(event) => onChange({ ...filters, days: Number(event.target.value) })}
        >
          {RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
