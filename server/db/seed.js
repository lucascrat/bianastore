// Transcribes the data that used to be hardcoded in pwa/index.html (PRODUCTS,
// FEED_ITEMS, CATEGORIES, NOTIFICATIONS) into Postgres, so the storefront keeps
// showing the same catalog after the cutover to the API. Guarded so re-running
// on every deploy never duplicates rows.
const pool = require('./pool');

const IMGS = {
  dress1: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBTCnuC_DeoKd7UM6RBq3-QVG9hGoJ8cozOJ8eGLCG0PGYWMOVe58ZXlVtNp8S0yGUH32ZQSgmXqKBnM1DUG2Ie7GD-twV1C_vbwCu_UKFsjWGWczilAc3n2TCvgO1PKYvJLysneVA86J6LnHJcUIfpaXx6M33lv9jO38ifuq68Zgn5pZwm9nWDaSdwM7g_pC38l-QtXH9W-lYWxyLgy9hw1lHkjNW7jd8wGZKQDUa7rjOvBkV2vv9u',
  dress2: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAXl-TVpDCuG-l_UFcYdr2u6VuHDFuFvhJhCYjyHZhgHfvWA1LRh-rGzmms3cBusMYmVSNo3W3H0LAjqQ3ur8AlfhpePcXCuBk5CCrj_wwtheCGwzsU_bsSt5Fx3wicspXs1Bl8G8AeGPIgsP45zDfuGsJP6Hn3HHmXy06WJ7hXckDti1y1uZtx3Y2OibISZ2-u3-NrQVsxmpB2FeVo_J4DBtPL9Co4PmDQrazoXu4se2IjuWItw3fd',
  blazer: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCK5AVnGBYaT6MwVyYgzItb_jWKDVZRHRCJpdG8rX2soONEznsFVmUIp6rz7f2MAGOKbOycGkmtUAzhG_5oDUNePugGWxneq6FRwkzQWJfMwe9Im_Vfa3ZqrRzCoK-r_DYK5aVFM40KpXyzHlb-lJ23ajDWzq0nbtMe2Vf6UpumDC-gOGWy8un5BkaTJ5GCMH5IaLHFWzfali4cWvzaPHOaGxf9TGRXbzNgXb0zAU1I_fezWpVvH5U4',
  pants: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCQ6He_zMe1ypA_DFOeCVjQAwnXQkieapHPbOAMzWQIXpFichyymE8ijm8ju2OAv_yx6cP1S3wfQui1VpPtFVdbdLXRrpiRIw3HEhh_c5GO2tM7y2omUfe4cLl1wjG734Y1Ici3IacbQOVnYBq6A8BMNSD24QM4TIX4hdHUW3hLU_RHWWiU0MpqQouLaa6VBh7OKmjdLsK7AaC16xyuRcQ9YXlLYJXWwRXszRfZysvnBvgRRo3yNLKR',
  top: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDE11Uooq-9rOkMHopokDEcOOylf6xsTvO0ZGAtry05i6_Fbhf7Qr85LJZeP7FolfWwbFa84jRXtj3_yrJcz4kz0ZWgUqkSVGG7r0CcSyg1g6W5_8e_7yflRKO_hdi8giGD7PY0N_qve16udFpX5Vaqc2cduKt-q_H84vNwezB7O0GAtZ-4pyWByj-nNt3YFoCWjri_TOaQwIwTPhH9xFPyFcOZX9l4k75YhbijPMqmZWR7xJvGrsgH',
  bag: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBrvbu3dLiadcICe34-UNnIVhlHiOo3MwxH75ZatWvylWCN_x8JlPP5oag9HzJpfPMITccKk3v2d2RzTGTWp4wpk7CP01WYHWYa2zlExDOce9jeZmPU-nGN5TGDYjQoKpGCCHTzKaEkGMdjSVelbFr8CvFzVue96lutcWo4z416nTzWK_I_2KZ7XgUONxblLlZt_srxFZSau_gLQH5UsFC_g-Vjn7tzQsBakcpTsf_3ocOeP4xNUq4S',
};

const CATEGORIES = ['Vestidos', 'Blazers', 'Calças', 'Tops', 'Bolsas'];

const PRODUCTS = [
  { name: 'Vestido Midi Elegante', sub: 'Crepe de seda fluido', price: 199, oldPrice: 299, img: IMGS.dress1, cat: 'Vestidos', colors: ['#F5C2C7', '#191c1d', '#BEAB99'], sizes: ['P', 'M', 'G', 'GG'], desc: 'O Vestido Midi Elegante é perfeito para ocasiões especiais. Confeccionado em crepe de seda de alta qualidade com caimento fluido, decote V sutil e fenda lateral moderna.', rating: 4.8, reviews: 234 },
  { name: 'Blazer Alfaiataria', sub: 'Corte slim premium', price: 349, oldPrice: null, img: IMGS.blazer, cat: 'Blazers', colors: ['#E8DCC8', '#191c1d', '#8B7355'], sizes: ['P', 'M', 'G'], desc: 'Blazer de alfaiataria com caimento slim e estrutura impecável. Tecido premium com toque suave e acabamento de alta costura.', rating: 4.9, reviews: 187 },
  { name: 'Calça Pantalona', sub: 'Tecido fluido premium', price: 199, oldPrice: 249, img: IMGS.pants, cat: 'Calças', colors: ['#C8D8E4', '#F5D5B0', '#191c1d'], sizes: ['34', '36', '38', '40', '42'], desc: 'Calça pantalona de perna larga com tecido fluido e cintura alta. Modelagem sofisticada que alonga a silhueta.', rating: 4.7, reviews: 156 },
  { name: 'Top de Seda', sub: 'Cetim luminoso', price: 129, oldPrice: 179, img: IMGS.top, cat: 'Tops', colors: ['#F5E6D3', '#D4E8D4', '#E8D4E8'], sizes: ['PP', 'P', 'M', 'G'], desc: 'Top camisete em cetim com brilho suave. Modelagem minimalista e elegante para composições versáteis dia e noite.', rating: 4.6, reviews: 98 },
  { name: 'Vestido Floral', sub: 'Manga bufante', price: 249, oldPrice: 359, img: IMGS.dress2, cat: 'Vestidos', colors: ['#FFB6C1', '#98D8C8', '#F5E6D3'], sizes: ['P', 'M', 'G', 'GG'], desc: 'Vestido midi floral com mangas bufante e saia rodada. Estampa exclusiva primavera/verão com tecido levíssimo.', rating: 4.9, reviews: 312 },
  { name: 'Bolsa Transversal', sub: 'Couro italiano', price: 259, oldPrice: null, img: IMGS.bag, cat: 'Bolsas', colors: ['#C8B89A', '#191c1d', '#8B5E3C'], sizes: ['Único'], desc: 'Bolsa crossbody em couro genuíno com ferragens douradas. Compartimento principal espaçoso e bolso frontal com zíper.', rating: 4.8, reviews: 203 },
];

// index into PRODUCTS (0-based) + feed-specific fields, matching FEED_ITEMS in index.html
const FEED = [
  { productIdx: 0, bg: IMGS.dress2, likes: 12400, comments: 842, sale: '33% OFF' },
  { productIdx: 4, bg: IMGS.dress1, likes: 8200, comments: 531, sale: '30% OFF' },
  { productIdx: 1, bg: IMGS.blazer, likes: 5100, comments: 287, sale: null },
  { productIdx: 2, bg: IMGS.pants, likes: 3800, comments: 194, sale: '20% OFF' },
];

const NOTIFICATIONS = [
  { type: 'sale', icon: 'local_offer', title: 'Flash Sale! 40% OFF', desc: 'Novos vestidos com desconto por tempo limitado. Corra!' },
  { type: 'order', icon: 'package_2', title: 'Pedido enviado', desc: 'Seu Vestido Midi Elegante está a caminho. Previsão: amanhã.' },
  { type: 'fav', icon: 'favorite', title: 'Item no favorito com desconto', desc: 'Blazer Alfaiataria baixou 15%. Aproveite!' },
  { type: 'order', icon: 'check_circle', title: 'Pedido entregue', desc: 'Seu pedido foi entregue. Avalie sua compra!' },
  { type: 'promo', icon: 'celebration', title: 'BianaStore Points: +120', desc: 'Você ganhou pontos pela sua última compra!' },
];

async function seed() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*)::int AS count FROM products');
    if (rows[0].count > 0) {
      console.log(`Seed skipped: ${rows[0].count} product(s) already exist.`);
      return;
    }

    await client.query('BEGIN');

    const categoryIds = {};
    for (let i = 0; i < CATEGORIES.length; i++) {
      const { rows } = await client.query(
        'INSERT INTO categories (name, sort_order) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id',
        [CATEGORIES[i], i]
      );
      categoryIds[CATEGORIES[i]] = rows[0].id;
    }

    const productIds = [];
    for (const p of PRODUCTS) {
      const { rows } = await client.query(
        `INSERT INTO products (name, sub, price, old_price, category_id, colors, sizes, description, rating, reviews_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [p.name, p.sub, p.price, p.oldPrice, categoryIds[p.cat], JSON.stringify(p.colors), JSON.stringify(p.sizes), p.desc, p.rating, p.reviews]
      );
      const productId = rows[0].id;
      productIds.push(productId);
      await client.query(
        'INSERT INTO product_images (product_id, url, sort_order, is_primary) VALUES ($1,$2,0,true)',
        [productId, p.img]
      );
      // Stock variants: schema.sql's own backfill only sees products that
      // already exist, so on a brand-new database it runs BEFORE this seed
      // inserts any — without this, freshly-seeded demo products would show
      // zero stock everywhere until the next deploy re-runs that backfill.
      for (const color of p.colors.length ? p.colors : ['']) {
        for (const size of p.sizes.length ? p.sizes : ['']) {
          await client.query(
            `INSERT INTO product_variants (product_id, color, size, stock_qty) VALUES ($1,$2,$3,20)
             ON CONFLICT (product_id, color, size) DO NOTHING`,
            [productId, color, size]
          );
        }
      }
    }

    for (const f of FEED) {
      await client.query(
        `INSERT INTO feed_items (product_id, media_url, media_type, likes_count, comments_count, sale_badge)
         VALUES ($1,$2,'image',$3,$4,$5)`,
        [productIds[f.productIdx], f.bg, f.likes, f.comments, f.sale]
      );
    }

    for (const n of NOTIFICATIONS) {
      await client.query(
        `INSERT INTO notifications (user_id, type, icon, title, description, unread)
         VALUES (NULL,$1,$2,$3,$4,true)`,
        [n.type, n.icon, n.title, n.desc]
      );
    }

    await client.query('COMMIT');
    console.log(`Seed complete: ${CATEGORIES.length} categories, ${PRODUCTS.length} products, ${FEED.length} feed items, ${NOTIFICATIONS.length} notifications.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
