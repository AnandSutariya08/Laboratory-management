import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '../../design/PageHeader'
import { Segmented } from '../../design/Segmented'
import { SkeletonRows } from '../../design/Skeletons'
import { useInventory } from './lib/useInventory'
import Dashboard from './components/Dashboard'
import CurrentStock from './components/CurrentStock'
import PurchaseOrders from './components/PurchaseOrders'
import ItemsSuppliers from './components/ItemsSuppliers'
import StockMapping from './components/StockMapping'
import '../qc/qc.css'

const SECTIONS = ['dashboard', 'stock', 'purchase-orders', 'items', 'mapping'] as const
type Section = (typeof SECTIONS)[number]

const LABELS: Record<Section, string> = {
  dashboard: 'Dashboard',
  stock: 'Current Stock',
  'purchase-orders': 'Purchase Order',
  items: 'Items & Suppliers',
  mapping: 'Stock Mapping',
}

export default function InventoryPage() {
  const { section } = useParams()
  const nav = useNavigate()
  const inv = useInventory()
  const active: Section = (SECTIONS as readonly string[]).includes(section ?? '') ? (section as Section) : 'dashboard'

  const body = () => {
    switch (active) {
      case 'stock':
        return <CurrentStock inv={inv} />
      case 'purchase-orders':
        return <PurchaseOrders inv={inv} />
      case 'items':
        return <ItemsSuppliers inv={inv} />
      case 'mapping':
        return <StockMapping inv={inv} />
      default:
        return <Dashboard inv={inv} />
    }
  }

  return (
    <div>
      <PageHeader title="Inventory" subtitle="Stock, purchasing, suppliers and test-to-item consumption." />
      <div className="qc-subnav">
        <Segmented
          aria-label="Inventory sections"
          value={active}
          onChange={(k) => nav(k === 'dashboard' ? '/inventory' : `/inventory/${k}`)}
          options={SECTIONS.map((k) => ({ value: k, label: LABELS[k] }))}
        />
      </div>
      {inv.loading && inv.items.length === 0 ? <SkeletonRows /> : body()}
    </div>
  )
}
