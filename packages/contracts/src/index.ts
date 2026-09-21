export interface HealthResponse {
  status: "healthy" | "attention";
  objectCount: number;
  diagnostics: string[];
}

export interface ObjectSummary {
  id: string;
  type: string;
  title: string;
  relativePath: string;
  revision: number;
  contentHash: string;
}
