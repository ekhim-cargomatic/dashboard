/**
 * One filter row above the charts, per the composition rule — never per-chart
 * controls scattered through the page.
 *
 * Every control narrows the run set that all charts read from, so the whole
 * dashboard always describes one coherent slice.
 */

import type { Filters as FilterState } from '../lib/aggregate';
import type { GroupBy } from '../types';

interface Facet {
  value: string;
  label: string;
  count: number;
}

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  groupBy: GroupBy;
  onGroupByChange: (next: GroupBy) => void;
  facets: {
    workflows: Facet[];
    environments: Facet[];
    branches: Facet[];
  };
  runCount: number;
}

const RANGES = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 0, label: 'All time' },
];

const GROUP_OPTIONS: { value: GroupBy; label: string; hint: string }[] = [
  { value: 'domain', label: 'Risk domain', hint: 'Behave tags folded into tag_map.yaml business areas — one bucket per scenario' },
  { value: 'tag', label: 'Tag', hint: 'Raw behave tags — a scenario appears under each of its tags, so rows overlap' },
  { value: 'suite', label: 'Feature', hint: 'The Feature the scenario belongs to' },
  { value: 'layer', label: 'Layer', hint: 'API / UI / E2E tags' },
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
    <div className="field">
      <label htmlFor={`filter-${label}`}>{label}</label>
      <select id={`filter-${label}`} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </div>
  );
}

export function Filters({
  filters,
  onChange,
  groupBy,
  onGroupByChange,
  facets,
  runCount,
}: Props) {
  const groupHint = GROUP_OPTIONS.find((option) => option.value === groupBy)?.hint;

  return (
    <div className="filters">
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

      <div className="field">
        <label htmlFor="filter-range">Time range</label>
        <select
          id="filter-range"
          value={filters.days}
          onChange={(event) => onChange({ ...filters, days: Number(event.target.value) })}
        >
          {RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Group areas by</label>
        <div className="segmented" role="group" aria-label="Group areas by">
          {GROUP_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={groupBy === option.value}
              title={option.hint}
              onClick={() => onGroupByChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field" style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>
        <span className="dim" style={{ fontSize: 12 }}>
          {runCount} run{runCount === 1 ? '' : 's'} in view
        </span>
        {groupHint && (
          <span className="dim" style={{ fontSize: 11 }}>
            {groupHint}
          </span>
        )}
      </div>
    </div>
  );
}
