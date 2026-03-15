/**
 * Scan2 Screen — First-person terrain exploration test environment
 *
 * Will place the user at ground level inside a topographic map
 * (like ExploreScreen but first-person) with 360° look controls.
 * Currently a placeholder to confirm routing works.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { createLogger } from '../../core/logger'
import styles from './Scan2Screen.module.css'

const log = createLogger('SCREEN:SCAN2')

const Scan2Screen: React.FC = () => {
  log.info('Scan2Screen mounted')

  return (
    <div className={styles.screen}>
      <div className={styles.title}>Scan 2</div>
      <div className={styles.subtitle}>First-Person Terrain — Test Environment</div>
      <div className={styles.route}>/scan2</div>
      <Link to="/" className={styles.backLink}>← Back to App</Link>
    </div>
  )
}

export default Scan2Screen
