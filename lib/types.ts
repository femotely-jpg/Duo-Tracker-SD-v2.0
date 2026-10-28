export type ModelAvail = { available: boolean; quote: string };
export type Store = {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  distance: number;
  models: Record<string, ModelAvail>;
};
export type Payload = {
  ok: boolean;
  configured: boolean;
  checkedAt: number;
  stores: Store[];
  skipped?: string[];
  error?: string;
};
