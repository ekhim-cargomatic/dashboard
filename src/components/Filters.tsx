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
  { value: 'domain', label: 'Risk domain', hint: 'Business areas from tag_map.yaml' },
  { value: 'suite', label: 'Feature path', hint: 'Directory the .feature file lives in' },
  { value: 'layer', label: 'Layer', hint: 'API / UI / E2E tags' },
];

function Select({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string;
  options: Facet[];
  onChange: (next: string) => void;
  allLabel: string;
}) {
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
        label="Workflow"
        value={filters.workflow}
        options={facets.workflows}
        onChange={(workflow) => onChange({ ...filters, workflow })}
        allLabel="All workflows"
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
