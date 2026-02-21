/// <reference types="vite/client" />

/**
 * CSS Module declarations
 *
 * TypeScript doesn't know about CSS Modules by default.
 * This declaration tells TypeScript that importing a *.module.css file
 * returns an object of string key → string value (the hashed class names).
 *
 * Example: import styles from './Foo.module.css'
 * styles.myClass → "Foo_myClass_abc123" (the generated class name)
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

/**
 * Vite client types are included by the /// reference above.
 * That gives us:
 * - import.meta.env (VITE_*, MODE, DEV, PROD, etc.)
 * - import.meta.hot (HMR)
 * - import.meta.glob (dynamic imports)
 */
