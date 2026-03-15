/**
 * B2 Wrap Screen — Fullscreen 360° panorama projection surface
 *
 * Will render the ScanScreen renderer at 10880×1080 with full 360° panorama.
 * North centered, South split at edges. AGL slider + coordinate overlay.
 * Currently a placeholder to confirm routing works.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { createLogger } from '../../core/logger'
import styles from './B2WrapScreen.module.css'

const log = createLogger('SCREEN:B2-WRAP')

const B2WrapScreen: React.FC = () => {
  log.info('B2WrapScreen mounted')

  return (
    <div className={styles.screen}>
      <div className={styles.title}>B2 Wrap</div>
      <div className={styles.subtitle}>360° Cylindrical Projection — Scan V1</div>
      <div className={styles.route}>/b2-wrap</div>
      <Link to="/" className={styles.backLink}>← Back to App</Link>
    </div>
  )
}

export default B2WrapScreen
