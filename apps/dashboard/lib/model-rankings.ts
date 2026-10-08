import type { CapabilityAxis, CatalogModel } from '@routeshift/shared';

function stableModelOrder(a: CatalogModel, b: CatalogModel): number {
  return a.owned_by.localeCompare(b.owned_by) || a.id.localeCompare(b.id);
}

function positivePrice(model: CatalogModel, field: 'prompt' | 'completion'): number | null {
  const price = Number(model.pricing[field]);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function rankCheapest(
  models: readonly CatalogModel[],
  field: 'prompt' | 'completion',
): CatalogModel[] {
  return models
    .filter((model) => (
      !(field === 'completion' && model.architecture?.modality === 'text->embedding')
      && positivePrice(model, field) !== null
    ))
    .slice()
    .sort((a, b) => {
      const priceOrder = positivePrice(a, field)! - positivePrice(b, field)!;
      return priceOrder || stableModelOrder(a, b);
    });
}

export function rankCheapestInput(models: readonly CatalogModel[]): CatalogModel[] {
  return rankCheapest(models, 'prompt');
}

export function rankCheapestOutput(models: readonly CatalogModel[]): CatalogModel[] {
  return rankCheapest(models, 'completion');
}

export function rankLargestContext(models: readonly CatalogModel[]): CatalogModel[] {
  return models
    .filter((model) => Number.isFinite(model.context_length) && model.context_length > 0)
    .slice()
    .sort((a, b) => b.context_length - a.context_length || stableModelOrder(a, b));
}

export function rankCapability(
  models: readonly CatalogModel[],
  axis: CapabilityAxis,
): CatalogModel[] {
  return models
    .filter((model) => {
      const capability = model.capability_indices;
      const value = capability?.[axis];
      return capability !== undefined
        && typeof value === 'number'
        && Number.isFinite(value)
        && capability.source.length > 0
        && capability.source_as_of.length > 0;
    })
    .slice()
    .sort((a, b) => {
      const capabilityOrder = b.capability_indices![axis]! - a.capability_indices![axis]!;
      return capabilityOrder || stableModelOrder(a, b);
    });
}
