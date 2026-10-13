import type { ItemClassification } from './Classification';

export type Item = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  classification: ItemClassification;
  completedAt?: string;
};
