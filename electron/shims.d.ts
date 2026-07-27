// The scripts/lib/*.mjs modules are plain JS with no .d.ts — loaded via dynamic
// import() in main.cts and treated as `any` there (see loadLibs()'s JSDoc for shapes).
declare module '*.mjs'
