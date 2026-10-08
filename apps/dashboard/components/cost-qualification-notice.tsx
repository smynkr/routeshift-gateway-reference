export function CostQualificationNotice({ unknownCostRequests }: { unknownCostRequests: number }) {
  if (unknownCostRequests <= 0) return null;
  return (
    <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
      Spend and savings are observed lower bounds; {unknownCostRequests.toLocaleString()} request{unknownCostRequests === 1 ? '' : 's'} have unknown historical cost.
    </p>
  );
}
