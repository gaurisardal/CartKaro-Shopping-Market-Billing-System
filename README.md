# CartKaro - Supermarket Inventory & Billing System

CartKaro is a web-based supermarket management system with fast Point-of-Sale (POS) billing, live inventory tracking and sales analytics. It is built as a college project using plain HTML, CSS and JavaScript on the front end, with Supabase (PostgreSQL) as the database.

Website Link: https://cartkaro-supermarketbillingsystem.netlify.app/#inventory

Login Details:-

email : guest123@gmail.com

password: guest123

## Features

- **Dashboard** - today's sales, total invoices, inventory value, total revenue, low-stock alerts, best-selling products, and sales and payment charts
- **Product management** - add, edit, delete (or archive) products with category, barcode, cost and selling price, supplier and expiry date
- **Inventory** - live stock levels, low-stock and out-of-stock alerts, stock in/out/adjust, and a stock movement audit history
- **Barcode scanner** - look up products by barcode (USB scanner or manual entry)
- **Billing / POS** - cart, discounts, GST, Cash / UPI / Card payments, change calculation and printable receipts
- **Sales history** - search and filter past invoices, reprint receipts, return/void a bill (stock is restored)
- **Reports & analytics** - revenue trends, sales by category, best and slow-moving products
- **CSV export** - products, sales history, stock movements and analytics
- **Dark mode / Light mode** - toggle in the top navbar, remembered after refresh
- **Collapsible sidebar** - icons-only on desktop, slide-over menu on smaller screens

## Tech Stack

- HTML5, CSS3, JavaScript (ES6+)
- Bootstrap 5.3 and Bootstrap Icons
- Chart.js 4
- Supabase JS v2 (PostgreSQL database and authentication)

## Project Structure

```
CartKaro/
├── login.html        # Login page
├── index.html        # Main application (dashboard, POS, inventory, etc.)
├── app.js            # Application logic and Supabase access
├── style.css         # Main styles, sidebar and layout
├── dark-theme.css    # Dark mode styles
└── logo.png          # CartKaro logo
```

## Getting Started

1. Download or clone this repository.
2. Make sure all files above are in the same folder.
3. Open `login.html` in a browser, or host the folder on GitHub Pages or Netlify.
4. Sign in on the login page (demo login: Username `Admin`, Password `admin@123`).
5. In the app, click the **Supabase** badge in the top bar and sign in with a staff account to load live data.

> The login page is a front-end demo only and is not real security. Data access is protected by Supabase authentication and Row Level Security.

## Database

All products, inventory, bills, payments, customers and stock movements are stored in Supabase. Writes go through PostgreSQL functions (RPC) so every operation is atomic. The setup file `cartkaro_fix.sql` must be run once in the Supabase SQL Editor.

Only shop settings (name, address, GST defaults) and the theme choice are stored in the browser's LocalStorage.

## Dark Mode

Click the moon/sun button in the top navbar to switch themes. The choice is saved in LocalStorage and applied before the page loads, so there is no flash on refresh. The login page is not affected.

## Notes

- Keep `style.css`, `dark-theme.css` and `app.js` in the same folder as `index.html`.
- After updating files on a host, press `Ctrl + Shift + R` to bypass the browser cache.

## Author

Developed as a college project.
