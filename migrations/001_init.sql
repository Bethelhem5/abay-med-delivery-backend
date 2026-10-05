CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','CUSTOMER','PHARMACY','DELIVERY')),
  full_name TEXT NOT NULL,
  phone TEXT,
  photo_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  reset_token_hash TEXT, reset_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE customer_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE, emergency_contact_name TEXT, emergency_contact_phone TEXT
);
CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, address_line TEXT NOT NULL, city TEXT, sub_city TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON addresses(user_id);
CREATE TABLE pharmacies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL, license_number TEXT UNIQUE NOT NULL, registration_number TEXT, tin TEXT,
  phone TEXT, email TEXT, address TEXT NOT NULL, city TEXT, sub_city TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION,
  opening_time TIME DEFAULT '08:00', closing_time TIME DEFAULT '21:00', is_24h BOOLEAN DEFAULT FALSE,
  emergency_available BOOLEAN DEFAULT FALSE, logo_url TEXT, image_url TEXT, description TEXT, services TEXT,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','APPROVED','REJECTED')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE pharmacy_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_pharmacist BOOLEAN DEFAULT TRUE, UNIQUE(pharmacy_id, user_id)
);
CREATE TABLE delivery_persons (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  id_number TEXT, vehicle_type TEXT, vehicle_plate TEXT, license_info TEXT, address TEXT,
  emergency_contact TEXT, current_lat DOUBLE PRECISION, current_lng DOUBLE PRECISION, location_updated_at TIMESTAMPTZ,
  availability TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (availability IN ('AVAILABLE','BUSY','OFFLINE','SUSPENDED')),
  is_approved BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL, generic_name TEXT, brand_name TEXT, category TEXT, description TEXT,
  barcode TEXT UNIQUE, qr_code TEXT, strength TEXT, dosage_form TEXT, manufacturer TEXT,
  image_url TEXT, prescription_required BOOLEAN NOT NULL DEFAULT FALSE, storage_requirement TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON medicines (lower(name));
CREATE INDEX ON medicines (lower(generic_name));
CREATE INDEX ON medicines (category);
CREATE TABLE medicine_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  stock_quantity INT NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  min_stock_level INT NOT NULL DEFAULT 10,
  batch_number TEXT, expiry_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(pharmacy_id, medicine_id)
);
CREATE INDEX ON medicine_inventory(pharmacy_id);
CREATE TABLE medicine_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id UUID NOT NULL REFERENCES medicine_inventory(id) ON DELETE CASCADE,
  batch_number TEXT NOT NULL, expiry_date DATE NOT NULL, quantity INT NOT NULL, received_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL, raw_text TEXT,
  status TEXT NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','SCANNED','APPROVED','REJECTED')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE prescription_medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, strength TEXT, dosage TEXT, quantity TEXT, instructions TEXT,
  confidence NUMERIC(4,3), edited_by_customer BOOLEAN DEFAULT FALSE
);
CREATE TABLE carts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), customer_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  inventory_id UUID NOT NULL REFERENCES medicine_inventory(id) ON DELETE CASCADE,
  quantity INT NOT NULL CHECK (quantity > 0), UNIQUE(cart_id, inventory_id)
);
CREATE SEQUENCE order_seq START 1000;
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT UNIQUE NOT NULL,
  customer_id UUID NOT NULL REFERENCES users(id),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(id),
  order_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (order_type IN ('STANDARD','EMERGENCY')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PHARMACY_REVIEW','CONFIRMED','PREPARING','READY_FOR_PICKUP','DELIVERY_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','CANCELLED','REJECTED')),
  subtotal NUMERIC(10,2) NOT NULL, delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0, total NUMERIC(10,2) NOT NULL,
  customer_name TEXT, customer_phone TEXT,
  delivery_address TEXT NOT NULL, delivery_lat DOUBLE PRECISION, delivery_lng DOUBLE PRECISION, delivery_instructions TEXT,
  prescription_id UUID REFERENCES prescriptions(id),
  prescription_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (prescription_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
  rejection_reason TEXT, estimated_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON orders(customer_id);
CREATE INDEX ON orders(pharmacy_id);
CREATE INDEX ON orders(status);
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inventory_id UUID REFERENCES medicine_inventory(id) ON DELETE SET NULL,
  medicine_name TEXT NOT NULL, quantity INT NOT NULL, unit_price NUMERIC(10,2) NOT NULL,
  prescription_required BOOLEAN DEFAULT FALSE
);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('CASH_ON_DELIVERY','MOBILE_PAYMENT','CARD')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED')),
  amount NUMERIC(10,2) NOT NULL, transaction_ref TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  delivery_person_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'DELIVERY_ASSIGNED' CHECK (status IN ('DELIVERY_ASSIGNED','GOING_TO_PHARMACY','ARRIVED_AT_PHARMACY','PICKED_UP','ON_THE_WAY','ARRIVED_AT_CUSTOMER','DELIVERED','CANCELLED')),
  otp TEXT NOT NULL, fee NUMERIC(10,2) DEFAULT 0, confirmation_photo TEXT, notes TEXT,
  assigned_at TIMESTAMPTZ DEFAULT now(), delivered_at TIMESTAMPTZ
);
CREATE INDEX ON deliveries(delivery_person_id);
CREATE TABLE delivery_declines (
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
  delivery_person_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(order_id, delivery_person_id)
);
CREATE TABLE delivery_locations (
  id BIGSERIAL PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL, recorded_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON delivery_locations(delivery_id, recorded_at DESC);
CREATE TABLE order_status_history (
  id BIGSERIAL PRIMARY KEY, order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL, note TEXT, changed_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, order_id UUID, is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON notifications(user_id, is_read);
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES users(id),
  pharmacy_id UUID REFERENCES pharmacies(id), delivery_person_id UUID REFERENCES users(id),
  target TEXT NOT NULL CHECK (target IN ('PHARMACY','DELIVERY')),
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5), comment TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(order_id, target)
);
CREATE TABLE refill_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL, quantity TEXT, interval_days INT NOT NULL CHECK (interval_days > 0),
  remind_days_before INT NOT NULL DEFAULT 3, next_refill_date DATE NOT NULL, last_reminded_for DATE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','CANCELLED')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, user_id UUID, action TEXT NOT NULL, entity TEXT, entity_id TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
