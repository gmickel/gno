import { FullGeneratorConfig, FullOfficeParserConfig, GeneratorConfig, OfficeParserConfig } from '../types.js';
/**
 * Checks if a configuration object is a FullGeneratorConfig.
 */
export declare function isFullGeneratorConfig(config: any): config is FullGeneratorConfig;
/**
 * Checks if a configuration object is a FullOfficeParserConfig.
 */
export declare function isFullParserConfig(config: any): config is FullOfficeParserConfig;
/**
 * Resolves a full parser configuration by merging defaults and user-provided overrides.
 *
 * The returned object always belongs solely to the caller of this function. That matters
 * because a parse installs per-call state on the config it is handed, such as the collector
 * that gathers warnings for one document's `ast.warnings`. Returning the caller's own object
 * would attach that state to an object they may reuse, so a second parse would append its
 * warnings to the first document's already-returned AST, and each parse would retain the
 * previous one's state for as long as the config lived.
 *
 * Only the configuration containers are copied. Callbacks and `abortSignal` keep their
 * identity, since a copy of an `AbortSignal` would no longer be tied to its controller.
 *
 * @param userConfig - Optional configuration provided by the user
 * @returns A fully populated configuration object, owned by the caller
 */
export declare function resolveParserConfig(userConfig?: OfficeParserConfig | FullOfficeParserConfig): FullOfficeParserConfig;
/**
 * Resolves a full, destination-specific configuration by merging defaults,
 * AST-level settings, and user-provided overrides.
 *
 * As with {@link resolveParserConfig}, the returned object belongs solely to the caller of this
 * function, so that per-run normalization cannot edit a config the caller still holds.
 *
 * @param destination - The target format
 * @param userConfig - Optional configuration provided by the user
 * @param astConfig - Optional configuration from the source AST (for inheritance)
 * @returns A fully populated configuration object, owned by the caller
 */
export declare function resolveGeneratorConfig<D extends string>(destination: D, astConfig?: OfficeParserConfig, userConfig?: GeneratorConfig<D> | FullGeneratorConfig): FullGeneratorConfig;
/**
 * Validates the containerWidth option for HTML generation.
 * Can be 'auto', a positive number, or a positive CSS length/percentage string.
 */
export declare function isValidContainerWidth(width: any): boolean;
