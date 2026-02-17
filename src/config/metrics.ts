export type ChoroplethLevel = "micromarkets" | "localities";

export type MetricFormat = "money" | "number";

export type MetricDef = {
  key: string;
  label: string;
  unit: string;
  format: MetricFormat;
  levels: ChoroplethLevel[];
  files: Record<ChoroplethLevel, string>;
  bucketCount: number;
};

export const METRICS: MetricDef[] = [
  {
    key: "asking_psf",
    label: "Asking (₹/sqft)",
    unit: "₹/sqft",
    format: "money",
    levels: ["micromarkets", "localities"],
    files: {
      micromarkets: "/metrics/asking_psf_micromarket.json",
      localities: "/metrics/asking_psf_localityname.json",
    },
    bucketCount: 5,
  },
  {
    key: "rent_psf",
    label: "Rent (₹/sqft)",
    unit: "₹/sqft",
    format: "money",
    levels: ["micromarkets", "localities"],
    files: {
      micromarkets: "/metrics/rent_psf_micromarket.json",
      localities: "/metrics/rent_psf_localityname.json",
    },
    bucketCount: 5,
  },
  {
    key: "rent_monthly",
    label: "Rent (₹/month)",
    unit: "₹/month",
    format: "money",
    levels: ["micromarkets", "localities"],
    files: {
      micromarkets: "/metrics/rent_monthly_micromarket.json",
      localities: "/metrics/rent_monthly_localityname.json",
    },
    bucketCount: 5,
  },
];

export function getMetricDef(key: string): MetricDef {
  const m = METRICS.find((x) => x.key === key);
  return m ?? METRICS[0];
}