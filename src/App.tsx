import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { AuthProvider } from './contexts/AuthContext';
import { PrivateRoute } from './components/PrivateRoute';
import { Dashboard } from './pages/Dashboard';
import { Catalogo } from './pages/Catalogo';
import { Suppliers } from './pages/Suppliers';
import { Vendedor } from './pages/Vendedor';
import { Warranties } from './pages/Warranties';
import { WarrantyShipments } from './pages/WarrantyShipments';
import { WarrantyCollections } from './pages/WarrantyCollections';
import { Profile } from './pages/Profile';
import { Wallet } from './pages/Wallet';
import { StoreSettings } from './pages/StoreSettings';
import { Sessions } from './pages/Sessions';
import { Withdrawals } from './pages/Withdrawals';
import { Plans } from './pages/Plans';
import { BankData } from './pages/BankData';
import { Users } from './pages/Users';
import { Referrals } from './pages/Referrals';
import { PortfolioHistory } from './pages/PortfolioHistory';
import { Clients } from './pages/Clients';
import { DropiCard } from './pages/DropiCard';
import { CarrierPreferences } from './pages/CarrierPreferences';
import { Orders } from './pages/Orders';
import { News } from './pages/News';
import { AbandonedCarts } from './pages/AbandonedCarts';
import { Labels } from './pages/Labels';
import { OrderSettings } from './pages/OrderSettings';
import { Invoices } from './pages/Invoices';
import { Notas } from './pages/Notas';
import { Reports } from './pages/Reports';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { NotFound } from './pages/NotFound';  
import { PageInDevelopment } from './pages/PageInDevelopment';
import { Calendar } from './pages/Calendar';
import { Campaign } from './pages/Campaign';
import { Automation } from './pages/Automation';
import { Setting } from './pages/Setting';
import { Integrations } from './pages/Integrations';
import { DetalleProducto } from './pages/DetalleProducto';






function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        
        {/* Redirect root to login */}
        <Route path="/" element={<Navigate to="/login" replace />} />
        
        {/* Protected routes */}
        <Route path="/dashboard" element={
          <PrivateRoute>
            <Layout>
              <Dashboard />
            </Layout>
          </PrivateRoute>
        } />
        
        {/* Other protected routes */}
        <Route path="/" element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }>
          <Route path="/home" element={<Home />} />
          <Route path="/productos/catalogo" element={<Catalogo />} />
          <Route path="/productos/proveedores" element={<Suppliers />} />
          <Route path="/productos/vendedor" element={<Vendedor />} />
          <Route path="/garantias/lista" element={<Warranties />} />
          <Route path="/garantias/despachos" element={<WarrantyShipments />} />
          <Route path="/garantias/recolecciones" element={<WarrantyCollections />} />
          <Route path="/pedidos/lista" element={<Orders />} />
          <Route path="/pedidos/novedades" element={<News />} />
          <Route path="/pedidos/carritos" element={<AbandonedCarts />} />
          <Route path="/pedidos/etiquetas" element={<Labels />} />
          <Route path="/pedidos/configuracion" element={<OrderSettings />} />
          <Route path="/perfil" element={<Profile />} />
          <Route path="/configuraciones/datos-personales" element={<Profile />} />
          <Route path="/billetera" element={<Wallet />} />
          <Route path="/configuraciones/tienda" element={<StoreSettings />} />
          <Route path="/configuraciones/sesiones" element={<Sessions />} />
          <Route path="/configuraciones/retiros" element={<Withdrawals />} />
          <Route path="/configuraciones/planes" element={<Plans />} />
          <Route path="/configuraciones/datos-bancarios" element={<BankData />} />
          <Route path="/usuarios" element={<Users />} />
          <Route path="/referidos" element={<Referrals />} />
          <Route path="/historial-cartera" element={<PortfolioHistory />} />
          <Route path="/clientes" element={<Clients />} />
          <Route path="/dropi-card" element={<DropiCard />} />
          <Route path="/transportadora/preferencias" element={<CarrierPreferences />} />
          <Route path="/facturas/facturas" element={<Invoices />} />
          <Route path="/facturas/notas" element={<Notas />} />
          <Route path="/desarrollo" element={<PageInDevelopment />} />
          <Route path="/reportes" element={<Reports />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/marketing/campaign" element={<Campaign />} />
          <Route path="/marketing/automation" element={<Automation />} />
          <Route path="/marketing/setting" element={<Setting />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/producto/:id" element={<DetalleProducto />} />

          

        </Route>

        {/* 404 Page */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}

export default App;
