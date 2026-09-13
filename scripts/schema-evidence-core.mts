import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type SchemaDeclaration = {
  physicalTableName: string;
  symbol: string;
  file: string;
};

export type TableReferences = {
  writers: string[];
  readers: string[];
};

type ProductionDocument = { file: string; source: string };

const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|mjs)$/;
const EXCLUDED_DIRECTORY = /(?:^|\/)(?:node_modules|\.git|\.next(?:-[^/]*)?|dist|build)(?:\/|$)/;
const TEST_OR_GENERATED_SOURCE =
  /(?:\.test\.|\.spec\.|(?:^|\/)(?:__tests__|test|tests|test-support|fixtures?|mocks?|fakes?|generated-evidence)(?:\/|$)|(?:^|\/)(?:[^/]*[-_.])?(?:mock|fake|fixture)(?:[-_.][^/]*)?\.(?:ts|tsx|mts|mjs)$)/;
const documentCache = new Map<string, ProductionDocument[]>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isProductionSourcePath(repositoryPath: string): boolean {
  const normalized = repositoryPath.replaceAll("\\", "/");
  if (!SOURCE_EXTENSIONS.test(normalized)) return false;
  if (EXCLUDED_DIRECTORY.test(normalized) || TEST_OR_GENERATED_SOURCE.test(normalized))
    return false;
  if (normalized.startsWith("e2e/")) return false;
  return /^(?:app|components|desktop|hooks|lib|scripts)\//.test(normalized);
}

export function listSourceFiles(root: string, path = root): string[] {
  if (!existsSync(path)) return [];
  const repositoryPath = relative(root, path).replaceAll("\\", "/");
  if (repositoryPath && EXCLUDED_DIRECTORY.test(repositoryPath)) return [];
  if (statSync(path).isFile()) return SOURCE_EXTENSIONS.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => listSourceFiles(root, resolve(path, entry)));
}

export function discoverSchemaDeclarations(root: string): SchemaDeclaration[] {
  const declarations: SchemaDeclaration[] = [];
  for (const absolutePath of listSourceFiles(root)) {
    const file = relative(root, absolutePath).replaceAll("\\", "/");
    if (!isProductionSourcePath(file)) continue;
    const source = readFileSync(absolutePath, "utf8");
    const pattern = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*mysqlTable\(\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      declarations.push({
        symbol: match[1] as string,
        physicalTableName: match[2] as string,
        file,
      });
    }
  }
  return declarations.sort((a, b) => a.physicalTableName.localeCompare(b.physicalTableName));
}

function productionDocuments(root: string): ProductionDocument[] {
  const cached = documentCache.get(root);
  if (cached) return cached;
  const documents = listSourceFiles(root).flatMap((absolutePath) => {
    const file = relative(root, absolutePath).replaceAll("\\", "/");
    if (!isProductionSourcePath(file)) return [];
    return [{ file, source: readFileSync(absolutePath, "utf8") }];
  });
  documentCache.set(root, documents);
  return documents;
}

export function scanCurrentProductionReferences(
  root: string,
  declaration: SchemaDeclaration,
): TableReferences {
  const writers = new Set<string>();
  const readers = new Set<string>();
  const symbol = escapeRegExp(declaration.symbol);
  const physicalName = escapeRegExp(declaration.physicalTableName);
  const symbolReference = new RegExp(`\\b${symbol}\\b`);
  const drizzleWrite = new RegExp(`\\.(?:insert|update|delete)\\(\\s*${symbol}\\b`);
  const drizzleRead = new RegExp(
    `\\.(?:from|join|leftJoin|rightJoin|innerJoin|fullJoin)\\(\\s*${symbol}\\b`,
  );
  const symbolColumnRead = new RegExp(`\\b${symbol}\\.[A-Za-z_$][\\w$]*`);
  const sqlWrite = new RegExp(
    `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+[\\x60"']?${physicalName}[\\x60"']?\\b`,
    "i",
  );
  const sqlRead = new RegExp(`\\b(?:FROM|JOIN)\\s+[\\x60"']?${physicalName}[\\x60"']?\\b`, "i");

  for (const { file, source } of productionDocuments(root)) {
    if (!isProductionSourcePath(file) || file === declaration.file) continue;
    if (source.includes("mysqlTable(")) continue;
    const hasSymbol = symbolReference.test(source);
    if ((hasSymbol && drizzleWrite.test(source)) || sqlWrite.test(source)) writers.add(file);
    if (
      (hasSymbol && (drizzleRead.test(source) || symbolColumnRead.test(source))) ||
      sqlRead.test(source)
    ) {
      readers.add(file);
    }
  }
  return { writers: [...writers].sort(), readers: [...readers].sort() };
}

export function assertCurrentProductionReference(
  root: string,
  declaration: SchemaDeclaration,
  repositoryPath: string,
): void {
  if (!isProductionSourcePath(repositoryPath)) {
    throw new Error(`${declaration.physicalTableName} 引用了非生产路径：${repositoryPath}`);
  }
  const absolutePath = resolve(root, repositoryPath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${declaration.physicalTableName} 引用了不存在的路径：${repositoryPath}`);
  }
  const source = readFileSync(absolutePath, "utf8");
  if (
    !new RegExp(`\\b${escapeRegExp(declaration.symbol)}\\b`).test(source) &&
    !new RegExp(`\\b${escapeRegExp(declaration.physicalTableName)}\\b`).test(source)
  ) {
    throw new Error(
      `${declaration.physicalTableName} 的证据路径未引用当前 symbol 或物理表名：${repositoryPath}`,
    );
  }
}
