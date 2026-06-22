import { docs } from '@/.source'
import { loader } from 'fumadocs-core/source'

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
})

export const getPage = source.getPage.bind(source)
export const getPages = source.getPages.bind(source)
