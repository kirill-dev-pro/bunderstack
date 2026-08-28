/* @refresh reload */
import '@knadh/oat/oat.min.css'
import { render } from 'solid-js/web'

import { App } from './app.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')

render(() => <App />, root)
