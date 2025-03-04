
import * as fs from 'fs-extra';
import * as path from 'path';
import ts, { NodeFlags } from 'typescript';
import ps from 'path';
import * as rConcepts from './r-concepts';
import { NameResolver } from './name-resolver';
import { distributeExports } from './distribute-exports';
import { recastTopLevelModule } from './recast';

const nodeFactory = ts.factory;

export interface IOptions {
    input: string | string[];
    rootDir?: string;
    output?: string;

    name?: string;
    rootModule?: string;
    entries?: Record<string, string>;

    exportPrivates?: string;
    shelterName?: string;
    verbose?: boolean;

    priority?: string[];

    /**
     * The name of js doc tag, the interface which is marked with this tag, should be racast into the non export namespace called '__private'.
     */
    privateJsDocTag?: string;

    groups?: Array<{
        test: RegExp;
        path: string;
    }>;

    /**
     * Specifies where to distribute non exported symbols.
     * If not specified, the non exported symbols are distributed to the module which firstly encountered them.
     */
    nonExportedSymbolDistribution?: Array<{
        /**
         * Regex to match the module name, where the symbol is originally declared.
         */
        sourceModule: RegExp;

        /**
         * Target module, should be in `entries`.
         */
        targetModule: string;
    }>;
}

export interface IBundleResult {
    groups: GroupResult[];
}

export interface GroupResult {
    path: string;
    typeReferencePaths?: string[];
    code: string;
};

export function bundle(options: IOptions): IBundleResult {
    if (options.verbose) {
        console.log(`Cwd: ${process.cwd()}`);
        console.log(`Options: ${JSON.stringify(options)}`);
        console.log(`TypeScript version: ${ts.version}`);
    }

    // Check the input.
    const inputs = Array.isArray(options.input) ? options.input : [options.input];
    if (!inputs.every(input => fs.existsSync(input))) {
        throw new Error(`Input file ${inputs} not found.`);
    }

    return rollupTypes(options);
}

class SymbolEntityMap {
    public set(symbol: ts.Symbol, entity: rConcepts.Entity) {
        // return this._map.set(symbol, entity);
        (symbol as any)[this._entitySymbol] = entity;
    }

    public get(symbol: ts.Symbol): rConcepts.Entity | undefined {
        // return this._map.get(symbol);
        return (symbol as any)[this._entitySymbol];
    }

    // private _map: Map<ts.Symbol, rConcepts.Entity> = new Map();

    private _entitySymbol = Symbol('[[Entity]]');
}

export function rollupTypes(options: IOptions) {
    const inputs = Array.isArray(options.input) ? options.input : [options.input];
    const rootDir = options.rootDir ?? ps.dirname(inputs[0]);
    const entries = getEntries();
    const program = createProgram();
    const typeChecker = program.getTypeChecker();
    const groupSources = bundle();
    const groups = groupSources.map(emit);
    return {
        groups,
    };

    interface GroupSource {
        path: string;
        statements: ts.Statement[];
    }

    function getEntries() {
        if (options.entries) {
            return options.entries;
        } else if (options.rootModule && options.name) {
            return {
                [options.name]: options.rootModule,
            };
        }
        throw new Error(`'entries' is not specified.`);
    }

    function createTscOptions(): ts.CompilerOptions {
        return {
            rootDir,
        };
    }

    function createProgram(): ts.Program {
        const tscOptions = createTscOptions();
        return ts.createProgram({
            rootNames: inputs,
            options: tscOptions,
        });
    }

    function bundle(): GroupSource[] {
        const ambientModules = typeChecker.getAmbientModules();

        const entryModules = Object.entries(entries).map(([entryModuleName, entryModuleId]) => {
            const name = `"${entryModuleId}"`;
            let moduleSymbol = ambientModules.find(m => m.getName() === name);
            if (!moduleSymbol) {
                const sourceFile = program.getSourceFile(entryModuleId);
                if (sourceFile) {
                    moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
                }
            }
            if (!moduleSymbol) {
                throw new Error(`Entry ${entryModuleName}: ${entryModuleId} is not found.`);
            }
            const referencingSymbols = getReferencingSymbolsInModule(moduleSymbol);
            return {
                referencingSymbols,
                name: entryModuleName,
                symbol: moduleSymbol,
            };
        });

        const rEntityMap = new SymbolEntityMap();

        const exportDistribution = distributeExports(entryModules.map((eM) => eM.symbol), typeChecker, options.priority, options.privateJsDocTag);

        const distributionMap = new Map<distributeExports.InternalModuleMeta, rConcepts.NamespaceTraits>();

        const neNamespaceMap = new Map<rConcepts.NamespaceTraits, {
            ns: rConcepts.NamespaceTraits;
            statements: ts.Statement[];
        }>();

        const rExternalModules = entryModules.map((entryModule, iEntryModule) => {
            const rModule = rConcepts.createModule(entryModule.name, entryModule.symbol);
            createREntities(exportDistribution[iEntryModule], rModule.namespaceTraits!);
            return rModule;
        });

        const visitModules = (
            moduleMeta: distributeExports.ModuleMeta,
            fx: (moduleMeta: distributeExports.ModuleMeta) => void,
        ) => {
            fx(moduleMeta);
            for (const mainExport of moduleMeta.mainExports) {
                if (mainExport.children) {
                    for (const child of mainExport.children) {
                        visitModules(child, fx);
                    }
                }
            }
        };

        for (const distribution of exportDistribution) {
            visitModules(distribution, addAliasExports);
        }

        const nameResolver = new NameResolver();
        const myRecast = (rModule: rConcepts.ModuleTraits) => recastTopLevelModule({
            program,
            typeChecker,
            rModule,
            nameResolver,
            resolveEntity: (symbol) => rEntityMap.get(symbol),
            registerNonExportedSymbol,
            privateJsDocTag: options.privateJsDocTag,
        });

        const groupSources = new Map<number, GroupSource>();
        for (const rModule of rExternalModules) {
            let groupIndex = -1;
            if (options.groups) {
                const rModuleName = rModule.name;
                const matchedGroup = options.groups.findIndex(groupOption => groupOption.test.test(rModuleName));
                if (matchedGroup >= 0) {
                    groupIndex = matchedGroup;
                }
            }
            let groupSource = groupSources.get(groupIndex);
            if (!groupSource) {
                let outputPath: string;
                if (groupIndex >= 0) {
                    outputPath = options.groups![groupIndex].path;
                } else {
                    if (!options.output) {
                        throw new Error(`You must specify <output> since there is a un-grouped module.`);
                    } else {
                        outputPath = options.output;
                    }
                }
                groupSource = {
                    statements: [],
                    path: outputPath,
                };
                groupSources.set(groupIndex, groupSource);
            }
            groupSource.statements.push(...myRecast(rModule.moduleTraits!));
        }
        return Array.from(groupSources.values());

        function getReferencingSymbolsInModule(symbol: ts.Symbol) {
            const referencingSymbols = new Set<ts.Symbol>();

            const declarations = symbol.getDeclarations();
            if (!declarations || declarations.length === 0) {
                return referencingSymbols;
            }

            for (const declaration of declarations) {
                const scopeSymbols = typeChecker.getSymbolsInScope(declaration, -1);
                for (const scopeSymbol of scopeSymbols) {
                    const declarations = scopeSymbol.getDeclarations();
                    if (!declarations || declarations.length === 0 || declarations.every((declaration) => {
                        const sourceFile = declaration.getSourceFile();
                        return program.isSourceFileDefaultLibrary(sourceFile) ||
                            program.isSourceFileFromExternalLibrary(sourceFile);
                    })) {
                        continue;
                    }
                    referencingSymbols.add(scopeSymbol);
                }
            }

            return referencingSymbols;
        }

        function createREntities(
            moduleExportDistribution: distributeExports.InternalModuleMeta,
            parent: rConcepts.NamespaceTraits,
        ) {
            distributionMap.set(moduleExportDistribution, parent);
            return moduleExportDistribution.mainExports.forEach((mainExport) => {
                const rEntity = new rConcepts.Entity(parent, mainExport.exportSymbol.name, mainExport.originalSymbol);
                if (mainExport.children) {
                    const namespaceTraits = rEntity.addNamespaceTraits();
                    for (const nestedModule of mainExport.children) {
                        createREntities(nestedModule, namespaceTraits);
                    }
                }
                rEntityMap.set(mainExport.originalSymbol, rEntity);
                return rEntity;
            });
        }

        function addAliasExports(moduleDistribution: distributeExports.InternalModuleMeta) {
            const rModule = distributionMap.get(moduleDistribution)!;
            for (const aeDistribution of moduleDistribution.aliasExports) {
                rModule.addAliasExport({
                    module: distributionMap.get(aeDistribution.module)!,
                    importName: aeDistribution.module.mainExports[aeDistribution.mainExportIndex].exportSymbol.name,
                    exportName: aeDistribution.exportSymbol.name,
                });
            }
        }

        function registerNonExportedSymbol(symbol: ts.Symbol, referencingNamespace: rConcepts.NamespaceTraits) {
            // TODO: what's this? I forgot.. But just keep unchanged.
            let referencingNamespaceInSource = referencingNamespace;
            while (!referencingNamespaceInSource.entity.symbol) {
                referencingNamespaceInSource = referencingNamespaceInSource.entity.parent.entity.namespaceTraits!;
            }

            const neNamespace = decideNeNamespaceForNonExportedSymbol(symbol, referencingNamespaceInSource);
            const name = generateUniqueName(symbol, neNamespace.trait, referencingNamespaceInSource);
            const entity = new rConcepts.Entity(neNamespace.trait, name, symbol);
            rEntityMap.set(symbol, entity);
            return {
                entity,
                addStatements: (statements: ts.Statement[]) => {
                    neNamespace!.statements.push(...statements);
                },
            };
        }

        function decideNeNamespaceForNonExportedSymbol(symbol: ts.Symbol, currentNamespaceInSource: rConcepts.NamespaceTraits) {
            const enclosing = getNeNamespaceOfEnclosingModule(symbol);
            if (enclosing) {
                return enclosing;
            }

            return currentNamespaceInSource.entity.ownerModuleOrThis.namespaceTraits.getOrCreateNENamespace();
        }

        function getNeNamespaceOfEnclosingModule(symbol: ts.Symbol) {
            const { nonExportedSymbolDistribution } = options;
            if (!nonExportedSymbolDistribution) {
                return;
            }

            const enclosingModuleName = getEnclosingModuleName(symbol);
            if (!enclosingModuleName) {
                return null;
            }

            for (const { sourceModule, targetModule } of nonExportedSymbolDistribution) {
                if (!sourceModule.test(enclosingModuleName)) {
                    continue;
                }
                const externalModule = rExternalModules.find(({ name }) => name === targetModule);
                if (!externalModule) {
                    return null;
                }
                return externalModule.namespaceTraits.getOrCreateNENamespace();
            }

            return null;
        }

        function getEnclosingModuleName(symbol: ts.Symbol): string | null {
            const declarations = symbol.getDeclarations();
            if (!declarations || declarations.length === 0) {
                return null;
            }
            const declaration0 = declarations[0];
            let currentNode: ts.Node = declaration0;
            const transformModuleName = (fileName: string) => {
                return fileName.replace(/[\\]/g, '/');
            };
            while (true) {
                if (ts.isSourceFile(currentNode)) {
                    return transformModuleName(currentNode.fileName);
                }
                if (ts.isModuleDeclaration(currentNode) && !(currentNode.flags & ts.NodeFlags.Namespace)) {
                    return transformModuleName(typeChecker.getSymbolAtLocation(currentNode.name)?.getName() ?? '');
                }
                currentNode = currentNode.parent;
            }
        }

        function generateUniqueName(symbol: ts.Symbol, parentModule: rConcepts.NamespaceTraits, referenceNamespaceTraits: rConcepts.NamespaceTraits): string {
            const declaration0 = symbol.getDeclarations()?.[0];
            if (!declaration0) {
                return symbol.getName();
            }

            const namespaces: string[] = [];

            let current: ts.Node = declaration0;

            if (!ts.isSourceFile(declaration0)) {
                // If the input isn't source file,
                // we directly extract its name in symbol,
                // otherwise we handle it further.
                namespaces.push(generateIdFromString(symbol.getName()));
                current = current.parent;
            }

            while (current) {
                if (ts.isSourceFile(current)) {
                    namespaces.unshift(generateIdFromSourceFileName(current.fileName));
                    break;
                } else if (ts.isModuleDeclaration(current)) {
                    namespaces.unshift(generateIdFromModuleDeclarationName(current.name));
                    if (ts.isSourceFile(current.parent) &&
                        !(current.flags & NodeFlags.Namespace) &&
                        ts.isStringLiteral(current.name)) {
                        // is `[declare] module "" {}` under source file
                        break;
                    }
                }
                current = current.parent;
            }

            const name = namespaces.join('_');
            return name;
        }

        function generateIdFromModuleDeclarationName(name: ts.ModuleName) {
            if (ts.isIdentifier(name)) {
                return name.text;
            } else {
                return generateIdFromString(name.text);
            }
        }

        function generateIdFromSourceFileName(fileName: string) {
            const relativeFromRoot = ps.relative(rootDir, fileName);
            const extensionStriped = relativeFromRoot.replace(/\.(js|ts|d\.ts)$/, '');
            return generateIdFromString(extensionStriped);
        }

        function generateIdFromString(text: string) {
            //  To handle keywords and illegal first letters, we prefix it with a legal letter.
            return '_' + text.replace(/[\/\\-]/g, '_').replace(/['":\.@]/g, '');
        }
    }

    function emit(groupSource: GroupSource): GroupResult {
        const printer = ts.createPrinter({
            newLine: ts.NewLineKind.LineFeed,
        });
        const sourceFile = ts.createSourceFile(
            path.basename(groupSource.path),
            '',
            ts.ScriptTarget.Latest,
            false,
            ts.ScriptKind.TS,
        );
        const lines: string[] = [];
        const statementsArray = nodeFactory.createNodeArray(groupSource.statements);
        const result = printer.printList(
            ts.ListFormat.MultiLine, statementsArray, sourceFile);
        lines.push(result);
        const code = lines.join('\n');
        return {
            path: groupSource.path,
            code,
        };
    }
}
