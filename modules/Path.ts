import {
    build as buildQueryParams,
    IOptions,
    parse as parseQueryParams
} from 'search-params'
import { defaultOrConstrained } from './rules'
import tokenise, { IToken } from './tokeniser'

const identity = (_: any): any => _

const exists = val => val !== undefined && val !== null

const optTrailingSlash = (source, strictTrailingSlash) => {
    if (strictTrailingSlash) {
        return source
    }

    if (source === '\\/') {
        return source
    }

    return source.replace(/\\\/$/, '') + '(?:\\/)?'
}

const upToDelimiter = (source, delimiter) => {
    if (!delimiter) {
        return source
    }

    return /(\/)$/.test(source) ? source : source + '(\\/|\\?|\\.|;|$)'
}

const appendQueryParam = (params, param, val = '') => {
    const existingVal = params[param]

    if (existingVal === undefined) {
        params[param] = val
    } else {
        params[param] = Array.isArray(existingVal)
            ? existingVal.concat(val)
            : [existingVal, val]
    }

    return params
}

export interface IPartialTestOptions {
    caseSensitive?: boolean
    delimited?: boolean
    queryParams?: IOptions
}

export interface ITestOptions {
    caseSensitive?: boolean
    strictTrailingSlash?: boolean
    optionalQueryParams?: boolean
    queryParams?: IOptions
}

export interface IBuildOptions {
    ignoreConstraints?: boolean
    ignoreSearch?: boolean
    queryParams?: IOptions
}

export type TestMatch = object | null

export class Path {
    public static createPath(path) {
        return new Path(path)
    }

    public path: string
    public tokens: IToken[]
    public hasUrlParams: boolean
    public hasSpatParam: boolean
    public hasMatrixParams: boolean
    public hasQueryParams: boolean
    public spatParams: string[]
    public urlParams: string[]
    public queryParams: string[]
    public params: string[]
    public source: string

    constructor(path) {
        if (!path) {
            throw new Error('Missing path in Path constructor')
        }
        this.path = path
        this.tokens = tokenise(path)

        this.hasUrlParams =
            this.tokens.filter(t => /^url-parameter/.test(t.type)).length > 0
        this.hasSpatParam =
            this.tokens.filter(t => /splat$/.test(t.type)).length > 0
        this.hasMatrixParams =
            this.tokens.filter(t => /matrix$/.test(t.type)).length > 0
        this.hasQueryParams =
            this.tokens.filter(t => /^query-parameter/.test(t.type)).length > 0
        // Extract named parameters from tokens
        this.spatParams = this.getParams('url-parameter-splat')
        this.urlParams = this.getParams(/^url-parameter/)
        // Query params
        this.queryParams = this.getParams('query-parameter')
        // All params
        this.params = this.urlParams.concat(this.queryParams)
        // Check if hasQueryParams
        // Regular expressions for url part only (full and partial match)
        this.source = this.tokens
            .filter(t => t.regex !== undefined)
            .map(r => r.regex.source)
            .join('')
    }

    public isQueryParam(name: string): boolean {
        return this.queryParams.indexOf(name) !== -1
    }

    public test(path: string, opts?: ITestOptions): TestMatch {
        const options = {
            strictTrailingSlash: false,
            optionalQueryParams: false,
            queryParams: {},
            ...opts
        }
        // trailingSlash: falsy => non optional, truthy => optional
        const source = optTrailingSlash(
            this.source,
            options.strictTrailingSlash
        )
        // Check if exact match
        const match = this.urlTest(
            path,
            source + (this.hasQueryParams ? '(\\?.*$|$)' : '$'),
            opts
        )
        // If no match, or no query params, no need to go further
        if (!match || !this.hasQueryParams) {
            return match
        }
        // Extract query params
        const queryParams = parseQueryParams(path, options.queryParams)
        const unexpectedQueryParams = options.optionalQueryParams
            ? []
            : Object.keys(queryParams).filter(p => !this.isQueryParam(p))
        if (unexpectedQueryParams.length === 0) {
            // Extend url match
            Object.keys(queryParams).forEach(p => {
                match[p] = queryParams[p]
            })
            return match
        }

        return null
    }

    public partialTest(path: string, opts?: IPartialTestOptions): TestMatch {
        const options = { delimited: true, queryParams: {}, ...opts }
        // Check if partial match (start of given path matches regex)
        // trailingSlash: falsy => non optional, truthy => optional
        const source = upToDelimiter(this.source, options.delimited)
        const match = this.urlTest(path, source, options)

        if (!match) {
            return match
        }

        if (!this.hasQueryParams) {
            return match
        }

        const queryParams = parseQueryParams(path, options.queryParams)

        Object.keys(queryParams)
            .filter(p => this.isQueryParam(p))
            .forEach(p => appendQueryParam(match, p, queryParams[p]))

        return match
    }

    public build(params: object = {}, opts?: IBuildOptions): string {
        const options = {
            ignoreConstraints: false,
            ignoreSearch: false,
            queryParams: {},
            ...opts
        }
        const encodedUrlParams = Object.keys(params)
            .filter(p => !this.isQueryParam(p))
            .reduce((acc, key) => {
                if (!exists(params[key])) {
                    return acc
                }

                const val = params[key]
                const encode = this.isQueryParam(key) ? identity : encodeURI

                if (typeof val === 'boolean') {
                    acc[key] = val
                } else if (Array.isArray(val)) {
                    acc[key] = val.map(encode)
                } else {
                    acc[key] = encode(val)
                }

                return acc
            }, {})

        // Check all params are provided (not search parameters which are optional)
        if (this.urlParams.some(p => !exists(params[p]))) {
            const missingParameters = this.urlParams.filter(
                p => !exists(params[p])
            )
            throw new Error(
                "Cannot build path: '" +
                    this.path +
                    "' requires missing parameters { " +
                    missingParameters.join(', ') +
                    ' }'
            )
        }

        // Check constraints
        if (!options.ignoreConstraints) {
            const constraintsPassed = this.tokens
                .filter(
                    t =>
                        /^url-parameter/.test(t.type) && !/-splat$/.test(t.type)
                )
                .every(t =>
                    new RegExp(
                        '^' + defaultOrConstrained(t.otherVal[0]) + '$'
                    ).test(encodedUrlParams[t.val])
                )

            if (!constraintsPassed) {
                throw new Error(
                    `Some parameters of '${this.path}' are of invalid format`
                )
            }
        }

        const base = this.tokens
            .filter(t => /^query-parameter/.test(t.type) === false)
            .map(t => {
                if (t.type === 'url-parameter-matrix') {
                    return `;${t.val}=${encodedUrlParams[t.val[0]]}`
                }

                return /^url-parameter/.test(t.type)
                    ? encodedUrlParams[t.val[0]]
                    : t.match
            })
            .join('')

        if (options.ignoreSearch) {
            return base
        }

        const searchParams = this.queryParams
            .filter(p => Object.keys(params).indexOf(p) !== -1)
            .reduce((sparams, paramName) => {
                sparams[paramName] = params[paramName]
                return sparams
            }, {})
        const searchPart = buildQueryParams(searchParams, options.queryParams)

        return searchPart ? base + '?' + searchPart : base
    }

    private getParams(type: string | RegExp): string[] {
        const predicate =
            type instanceof RegExp
                ? t => type.test(t.type)
                : t => t.type === type

        return this.tokens.filter(predicate).map(t => t.val[0])
    }

    private urlTest(
        path: string,
        source: string,
        { caseSensitive = false } = {}
    ): TestMatch {
        const regex = new RegExp('^' + source, caseSensitive ? '' : 'i')
        const match = path.match(regex)
        if (!match) {
            return null
        } else if (!this.urlParams.length) {
            return {}
        }
        // Reduce named params to key-value pairs
        return match
            .slice(1, this.urlParams.length + 1)
            .reduce((params, m, i) => {
                params[this.urlParams[i]] = decodeURIComponent(m)
                return params
            }, {})
    }
}

export default Path
