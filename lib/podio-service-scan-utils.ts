// Utilidades compartidas para el módulo de escaneo

// Definir TEST_MODE_CONFIG si no existe
export const TEST_MODE_CONFIG = {
  workspacesPercent: 10,
  maxWorkspaces: 2,
  applicationsPercent: 10,
  maxApps: 2,
  itemsPercent: 10,
  maxItems: 5,
  filesPercent: 10,
  maxFiles: 10
};

export function isTestMode(): boolean {
  if (typeof window !== "undefined") {
    return (
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      localStorage.getItem("podio_test_mode") === "true"
    );
  }
  return process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true";
}





