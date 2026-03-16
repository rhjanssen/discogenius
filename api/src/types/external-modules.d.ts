declare module "fpcalc" {
  export type FpcalcResult = {
    duration?: number;
    fingerprint: string;
  };

  export type FpcalcCallback = (error: Error | null, result?: FpcalcResult) => void;

  const fpcalc: (filePath: string, callback: FpcalcCallback) => void;
  export default fpcalc;
}
