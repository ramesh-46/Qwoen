const express = require('express');
const cors = require('cors'); // Fixed: Changed 'carg' to 'cors'
const db = require('./db'); // Import PostgreSQL pool from db.js
const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(express.json());

// PUT /api/customers/:id — Update customer + optional address
app.put('/api/customers/:id', async (req, res) => {
  const customerId = req.params.id;
  const { first_name, last_name, phone_number, address_details, city, state, pin_code } = req.body;

  // Validate required fields
  if (!first_name || !last_name || !phone_number) {
    return res.status(400).json({ error: "First name, last name and phone number are required." });
  }
  if (!/^\d{10}$/.test(phone_number)) {
    return res.status(400).json({ error: "Phone number must be 10 digits." });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Update customer info
    const updateCustomerSql = "UPDATE customers SET first_name = $1, last_name = $2, phone_number = $3 WHERE id = $4 RETURNING *";
    const customerResult = await client.query(updateCustomerSql, [first_name, last_name, phone_number, customerId]);
    if (customerResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Customer not found." });
    }

    // If address is also being updated
    if (address_details && city && state && pin_code) {
      const insertAddressSql = `
        INSERT INTO addresses (customer_id, address_details, city, state, pin_code)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await client.query(insertAddressSql, [customerId, address_details, city, state, pin_code]);
    }

    await client.query('COMMIT');
    res.json({ message: address_details ? "Customer and address updated successfully." : "Customer updated successfully." });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/addresses — Add new address
app.post('/api/addresses', async (req, res) => {
  const { customer_id, address_details, city, state, pin_code } = req.body;
  if (!customer_id || !address_details || !city || !state || !pin_code) {
    return res.status(400).json({ error: "All fields required." });
  }
  try {
    const sql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES ($1, $2, $3, $4, $5) RETURNING *";
    const result = await db.query(sql, [customer_id, address_details, city, state, pin_code]);
    res.status(201).json({ address: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/addresses/:id — Update address
app.put('/api/addresses/:id', async (req, res) => {
  const { address_details, city, state, pin_code } = req.body;
  const addressId = req.params.id;
  if (!address_details || !city || !state || !pin_code) {
    return res.status(400).json({ error: "All fields required." });
  }
  try {
    const sql = "UPDATE addresses SET address_details = $1, city = $2, state = $3, pin_code = $4 WHERE id = $5 RETURNING *";
    const result = await db.query(sql, [address_details, city, state, pin_code, addressId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Address not found." });
    }
    res.json({ address: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/addresses/:id
app.delete('/api/addresses/:id', async (req, res) => {
  const addressId = req.params.id;
  try {
    const sql = "DELETE FROM addresses WHERE id = $1 RETURNING *";
    const result = await db.query(sql, [addressId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Address not found." });
    }
    res.json({ message: "Address deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/customers/:id
app.delete('/api/customers/:id', async (req, res) => {
  const customerId = req.params.id;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // First, delete all addresses for this customer
    await client.query("DELETE FROM addresses WHERE customer_id = $1", [customerId]);

    // Then, delete the customer
    const deleteCustomerSql = "DELETE FROM customers WHERE id = $1 RETURNING *";
    const result = await client.query(deleteCustomerSql, [customerId]);
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "Customer not found." });
    }

    await client.query('COMMIT');
    res.json({ message: "Customer and all associated addresses deleted successfully." });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/customers/search?q=term
app.get('/api/customers/search', async (req, res) => {
  const searchTerm = req.query.q || '';
  try {
    let sql, params;
    if (!searchTerm.trim()) {
      sql = `
        SELECT c.*, (
          SELECT json_agg(row_to_json(a))
          FROM addresses a
          WHERE a.customer_id = c.id
        ) as addresses
        FROM customers c
        ORDER BY c.id DESC
      `;
      params = [];
    } else {
      const term = `%${searchTerm}%`;
      sql = `
        SELECT DISTINCT c.*, (
          SELECT json_agg(row_to_json(a))
          FROM addresses a
          WHERE a.customer_id = c.id
        ) as addresses
        FROM customers c
        LEFT JOIN addresses a ON c.id = a.customer_id
        WHERE c.first_name ILIKE $1
           OR c.last_name ILIKE $1
           OR c.phone_number ILIKE $1
           OR a.address_details ILIKE $1
           OR a.city ILIKE $1
           OR a.state ILIKE $1
           OR a.pin_code ILIKE $1
        ORDER BY c.id DESC
      `;
      params = [term];
    }
    const result = await db.query(sql, params);
    const customers = result.rows.map(row => ({
      ...row,
      addresses: row.addresses || []
    }));
    res.json({ data: customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id
app.get('/api/customers/:id', async (req, res) => {
  const customerId = req.params.id;
  try {
    const customerSql = "SELECT * FROM customers WHERE id = $1";
    const customerResult = await db.query(customerSql, [customerId]);
    if (customerResult.rowCount === 0) {
      return res.status(404).json({ error: "Customer not found" });
    }
    const addressSql = "SELECT * FROM addresses WHERE customer_id = $1";
    const addressResult = await db.query(addressSql, [customerId]);
    res.json({
      data: {
        ...customerResult.rows[0],
        addresses: addressResult.rows,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers — with filtering by address count + search
app.get('/api/customers', async (req, res) => {
  const { addressCount, q: searchTerm } = req.query;
  try {
    let sql = `
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.phone_number,
        COUNT(a.id) AS address_count,
        COALESCE(
          json_agg(
            CASE
              WHEN a.id IS NOT NULL THEN row_to_json(a)
            END
          ), '[]'::json
        ) AS addresses
      FROM customers c
      LEFT JOIN addresses a ON c.id = a.customer_id
    `;
    const conditions = [];
    const params = [];
    if (searchTerm && searchTerm.trim()) {
      const term = `%${searchTerm.trim()}%`;
      conditions.push(
        `(c.first_name ILIKE $${params.length + 1}
         OR c.last_name ILIKE $${params.length + 1}
         OR c.phone_number ILIKE $${params.length + 1}
         OR a.address_details ILIKE $${params.length + 1}
         OR a.city ILIKE $${params.length + 1}
         OR a.state ILIKE $${params.length + 1}
         OR a.pin_code ILIKE $${params.length + 1})`
      );
      params.push(term);
    }
    let havingClause = "";
    if (addressCount === "single") {
      havingClause = "HAVING COUNT(a.id) = 1";
    } else if (addressCount === "multiple") {
      havingClause = "HAVING COUNT(a.id) > 1";
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += `
      GROUP BY c.id
      ${havingClause}
      ORDER BY c.id DESC
    `;
    const result = await db.query(sql, params);
    const customers = result.rows.map(row => ({
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      phone_number: row.phone_number,
      address_count: parseInt(row.address_count) || 0,
      addresses: row.addresses.filter(addr => addr !== null),
    }));
    res.json({ data: customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/count
app.get('/api/customers/count', async (req, res) => {
  const { addressCount, q: searchTerm } = req.query;
  try {
    let sql = `
      SELECT COUNT(*) as total
      FROM (
        SELECT c.id
        FROM customers c
        LEFT JOIN addresses a ON c.id = a.customer_id
    `;
    const conditions = [];
    const params = [];
    if (searchTerm && searchTerm.trim()) {
      const term = `%${searchTerm.trim()}%`;
      conditions.push(
        `(c.first_name ILIKE $${params.length + 1}
         OR c.last_name ILIKE $${params.length + 1}
         OR c.phone_number ILIKE $${params.length + 1}
         OR a.address_details ILIKE $${params.length + 1}
         OR a.city ILIKE $${params.length + 1}
         OR a.state ILIKE $${params.length + 1}
         OR a.pin_code ILIKE $${params.length + 1})`
      );
      params.push(term);
    }
    if (addressCount === 'single') {
      conditions.push(`a.id IS NOT NULL GROUP BY c.id HAVING COUNT(a.id) = 1`);
    } else if (addressCount === 'multiple') {
      conditions.push(`a.id IS NOT NULL GROUP BY c.id HAVING COUNT(a.id) > 1`);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    if (!addressCount) {
      sql += " GROUP BY c.id";
    }
    sql += ") as filtered_customers";
    const result = await db.query(sql, params);
    res.json({ count: result.rows[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers
app.post('/api/customers', async (req, res) => {
  const { first_name, last_name, phone_number, address_details, city, state, pin_code } = req.body;
  if (!first_name || !last_name || !phone_number || !address_details || !city || !state || !pin_code) {
    return res.status(400).json({ error: "All fields are required.", field: "general" });
  }
  if (!/^\d{10}$/.test(phone_number)) {
    return res.status(400).json({ error: "Phone number must be 10 digits.", field: "phone_number" });
  }
  if (!/^\d{6}$/.test(pin_code)) {
    return res.status(400).json({ error: "Pin code must be 6 digits.", field: "pin_code" });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Check for duplicate customer
    const checkSql = "SELECT id FROM customers WHERE first_name = $1 AND last_name = $2 AND phone_number = $3";
    const checkResult = await client.query(checkSql, [first_name, last_name, phone_number]);
    if (checkResult.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: "Customer with this name and phone number already exists.",
        field: "phone_number",
      });
    }

    // Insert customer
    const customerSql = "INSERT INTO customers (first_name, last_name, phone_number) VALUES ($1, $2, $3) RETURNING id";
    const customerResult = await client.query(customerSql, [first_name, last_name, phone_number]);
    const customerId = customerResult.rows[0].id;

    // Insert address
    const addressSql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES ($1, $2, $3, $4, $5)";
    await client.query(addressSql, [customerId, address_details, city, state, pin_code]);

    await client.query('COMMIT');
    res.status(201).json({
      message: "Customer and address created successfully.",
      customerId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message, field: "general" });
  } finally {
    client.release();
  }
});

// GET /api/customers/:id/addresses
app.get('/api/customers/:id/addresses', async (req, res) => {
  try {
    const sql = "SELECT * FROM addresses WHERE customer_id = $1";
    const result = await db.query(sql, [req.params.id]);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/:id/addresses
app.post('/api/customers/:id/addresses', async (req, res) => {
  const { address_details, city, state, pin_code } = req.body;
  if (!address_details || !city || !state || !pin_code) {
    return res.status(400).json({ error: "All address fields are required." });
  }
  if (!/^\d{6}$/.test(pin_code)) {
    return res.status(400).json({ error: "Pin code must be 6 digits." });
  }
  try {
    const sql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES ($1, $2, $3, $4, $5) RETURNING id";
    const result = await db.query(sql, [req.params.id, address_details, city, state, pin_code]);
    res.status(201).json({ message: 'Address added', addressId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});




// const express = require('express');
// const cors = require('cors');
// const db = require('./db'); // Your database connection
// const app = express();
// const PORT = 5000;

// // Middleware
// app.use(cors());
// app.use(express.json());
// // PUT /api/customers/:id — Update customer + optional address
// app.put('/api/customers/:id', (req, res) => {
//   const customerId = req.params.id;
//   const { first_name, last_name, phone_number, address_details, city, state, pin_code } = req.body;

//   // Validate required fields
//   if (!first_name || !last_name || !phone_number) {
//     return res.status(400).json({ error: "First name, last name and phone number are required." });
//   }
//   if (!/^\d{10}$/.test(phone_number)) {
//     return res.status(400).json({ error: "Phone number must be 10 digits." });
//   }

//   // Start transaction
//   db.getConnection((err, connection) => {
//     if (err) return res.status(500).json({ error: "Database connection failed." });

//     connection.beginTransaction(err => {
//       if (err) {
//         connection.release();
//         return res.status(500).json({ error: "Transaction failed." });
//       }

//       // Update customer info
//       const updateCustomerSql = "UPDATE customers SET first_name = ?, last_name = ?, phone_number = ? WHERE id = ?";
//       connection.query(updateCustomerSql, [first_name, last_name, phone_number, customerId], (err, result) => {
//         if (err) {
//           return connection.rollback(() => {
//             connection.release();
//             res.status(500).json({ error: "Failed to update customer." });
//           });
//         }
//         if (result.affectedRows === 0) {
//           return connection.rollback(() => {
//             connection.release();
//             res.status(404).json({ error: "Customer not found." });
//           });
//         }

//         // If address is also being updated
//         if (address_details && city && state && pin_code) {
//           const insertAddressSql = `
//             INSERT INTO addresses (customer_id, address_details, city, state, pin_code)
//             VALUES (?, ?, ?, ?, ?)
//           `;
//           connection.query(insertAddressSql, [customerId, address_details, city, state, pin_code], (err) => {
//             if (err) {
//               return connection.rollback(() => {
//                 connection.release();
//                 res.status(500).json({ error: "Failed to update address." });
//               });
//             }

//             connection.commit(err => {
//               if (err) {
//                 return connection.rollback(() => {
//                   connection.release();
//                   res.status(500).json({ error: "Commit failed." });
//                 });
//               }
//               connection.release();
//               res.json({ message: "Customer and address updated successfully." });
//             });
//           });
//         } else {
//           // Only customer updated
//           connection.commit(err => {
//             if (err) {
//               return connection.rollback(() => {
//                 connection.release();
//                 res.status(500).json({ error: "Commit failed." });
//               });
//             }
//             connection.release();
//             res.json({ message: "Customer updated successfully." });
//           });
//         }
//       });
//     });
//   });
// });

// // POST /api/addresses — Add new address
// app.post('/api/addresses', (req, res) => {
//   const { customer_id, address_details, city, state, pin_code } = req.body;

//   if (!customer_id || !address_details || !city || !state || !pin_code) {
//     return res.status(400).json({ error: "All fields required." });
//   }

//   const sql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES (?, ?, ?, ?, ?)";
//   db.query(sql, [customer_id, address_details, city, state, pin_code], (err, result) => {
//     if (err) return res.status(500).json({ error: err.message });
//     res.status(201).json({
//       address: {
//         id: result.insertId,
//         customer_id,
//         address_details,
//         city,
//         state,
//         pin_code,
//       },
//     });
//   });
// });

// // PUT /api/addresses/:id — Update address
// app.put('/api/addresses/:id', (req, res) => {
//   const { address_details, city, state, pin_code } = req.body;
//   const addressId = req.params.id;

//   if (!address_details || !city || !state || !pin_code) {
//     return res.status(400).json({ error: "All fields required." });
//   }

//   const sql = "UPDATE addresses SET address_details = ?, city = ?, state = ?, pin_code = ? WHERE id = ?";
//   db.query(sql, [address_details, city, state, pin_code, addressId], (err, result) => {
//     if (err) return res.status(500).json({ error: err.message });
//     if (result.affectedRows === 0) {
//       return res.status(404).json({ error: "Address not found." });
//     }

//     res.json({
//       address: {
//         id: parseInt(addressId),
//         address_details,
//         city,
//         state,
//         pin_code,
//       },
//     });
//   });
// });

// // DELETE /api/addresses/:id
// app.delete('/api/addresses/:id', (req, res) => {
//   const addressId = req.params.id;

//   const sql = "DELETE FROM addresses WHERE id = ?";
//   db.query(sql, [addressId], (err, result) => {
//     if (err) return res.status(500).json({ error: err.message });
//     if (result.affectedRows === 0) {
//       return res.status(404).json({ error: "Address not found." });
//     }
//     res.json({ message: "Address deleted successfully." });
//   });
// });

// // DELETE /api/customers/:id
// app.delete('/api/customers/:id', (req, res) => {
//   const customerId = req.params.id;

//   // Start transaction to ensure data consistency
//   db.getConnection((err, connection) => {
//     if (err) return res.status(500).json({ error: "Database connection failed." });

//     connection.beginTransaction((err) => {
//       if (err) {
//         connection.release();
//         return res.status(500).json({ error: "Transaction failed." });
//       }

//       // First, delete all addresses for this customer
//       const deleteAddressesSql = "DELETE FROM addresses WHERE customer_id = ?";
//       connection.query(deleteAddressesSql, [customerId], (err) => {
//         if (err) {
//           return connection.rollback(() => {
//             connection.release();
//             res.status(500).json({ error: "Failed to delete addresses." });
//           });
//         }

//         // Then, delete the customer
//         const deleteCustomerSql = "DELETE FROM customers WHERE id = ?";
//         connection.query(deleteCustomerSql, [customerId], (err, result) => {
//           if (err) {
//             return connection.rollback(() => {
//               connection.release();
//               res.status(500).json({ error: "Failed to delete customer." });
//             });
//           }

//           if (result.affectedRows === 0) {
//             return connection.rollback(() => {
//               connection.release();
//               res.status(404).json({ error: "Customer not found." });
//             });
//           }

//           // Commit transaction
//           connection.commit((err) => {
//             if (err) {
//               return connection.rollback(() => {
//                 connection.release();
//                 res.status(500).json({ error: "Failed to commit deletion." });
//               });
//             }

//             connection.release();
//             res.json({ message: "Customer and all associated addresses deleted successfully." });
//           });
//         });
//       });
//     });
//   });
// });

// // GET /api/customers/search?q=term
// app.get('/api/customers/search', (req, res) => {
//   const searchTerm = req.query.q || '';
  
//   if (!searchTerm.trim()) {
//     // Return all customers if no search term
//     const sql = `
//       SELECT c.*, 
//              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'customer_id', a.customer_id, 
//              'address_details', a.address_details, 'city', a.city, 'state', a.state, 'pin_code', a.pin_code))
//               FROM addresses a WHERE a.customer_id = c.id) as addresses
//       FROM customers c
//       ORDER BY c.id DESC
//     `;
//     db.query(sql, (err, results) => {
//       if (err) return res.status(500).json({ error: err.message });
      
//       // Process addresses from JSON string
//       const customers = results.map(row => {
//         return {
//           ...row,
//           addresses: row.addresses ? JSON.parse(row.addresses) : []
//         };
//       });
      
//       res.json({ data: customers });
//     });
//   } else {
//     // Search customers and their addresses
//     const term = `%${searchTerm}%`;
//     const sql = `
//       SELECT DISTINCT c.*,
//              (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', a.id, 'customer_id', a.customer_id, 
//              'address_details', a.address_details, 'city', a.city, 'state', a.state, 'pin_code', a.pin_code))
//               FROM addresses a WHERE a.customer_id = c.id) as addresses
//       FROM customers c
//       LEFT JOIN addresses a ON c.id = a.customer_id
//       WHERE c.first_name LIKE ? 
//          OR c.last_name LIKE ? 
//          OR c.phone_number LIKE ?
//          OR a.address_details LIKE ?
//          OR a.city LIKE ?
//          OR a.state LIKE ?
//          OR a.pin_code LIKE ?
//       ORDER BY c.id DESC
//     `;
    
//     const params = [term, term, term, term, term, term, term];
    
//     db.query(sql, params, (err, results) => {
//       if (err) return res.status(500).json({ error: err.message });
      
//       // Process addresses from JSON string
//       const customers = results.map(row => {
//         return {
//           ...row,
//           addresses: row.addresses ? JSON.parse(row.addresses) : []
//         };
//       });
      
//       res.json({ data: customers });
//     });
//   }
// });
// // DELETE /api/addresses/:id
// app.delete('/api/addresses/:id', (req, res) => {
//   const addressId = req.params.id;

//   // Optional: Check if address exists first
//   const checkSql = "SELECT * FROM addresses WHERE id = ?";
//   db.query(checkSql, [addressId], (err, results) => {
//     if (err) return res.status(500).json({ error: "Database error." });
//     if (results.length === 0) {
//       return res.status(404).json({ error: "Address not found." });
//     }

//     // Delete the address
//     const deleteSql = "DELETE FROM addresses WHERE id = ?";
//     db.query(deleteSql, [addressId], (err, result) => {
//       if (err) return res.status(500).json({ error: "Failed to delete address." });
//       res.json({ message: "Address deleted successfully." });
//     });
//   });
// });
// // Get single customer with addresses
// // Get single customer with addresses
// app.get('/api/customers/:id', (req, res) => {
//   const customerId = req.params.id;

//   const customerSql = "SELECT * FROM customers WHERE id = ?";
//   db.query(customerSql, [customerId], (err, customerResults) => {
//     if (err) return res.status(500).json({ error: err.message });
//     if (customerResults.length === 0) {
//       return res.status(404).json({ error: "Customer not found" });
//     }

//     const addressSql = "SELECT * FROM addresses WHERE customer_id = ?";
//     db.query(addressSql, [customerId], (err, addressResults) => {
//       if (err) return res.status(500).json({ error: err.message });

//       res.json({
//         data: {
//           ...customerResults[0],
//           addresses: addressResults,
//         },
//       });
//     });
//   });
// });



// // 1. Get all customers
// // app.get('/api/customers', (req, res) => {
// //   const sql = "SELECT * FROM customers";
// //   db.query(sql, (err, results) => {
// //     if (err) return res.status(500).json({ error: err.message });
// //     res.json({ data: results });
// //   });
// // });
// // ✅ UPDATED: GET /api/customers — with filtering by address count + search
// app.get('/api/customers', (req, res) => {
//   const { addressCount, q: searchTerm } = req.query;

//   let sql = `
//     SELECT 
//       c.id,
//       c.first_name,
//       c.last_name,
//       c.phone_number,
//       COUNT(a.id) AS address_count,
//       COALESCE(
//         JSON_ARRAYAGG(
//           CASE 
//             WHEN a.id IS NOT NULL THEN JSON_OBJECT(
//               'id', a.id,
//               'customer_id', a.customer_id,
//               'address_details', a.address_details,
//               'city', a.city,
//               'state', a.state,
//               'pin_code', a.pin_code
//             )
//           END
//         ), JSON_ARRAY()
//       ) AS addresses
//     FROM customers c
//     LEFT JOIN addresses a ON c.id = a.customer_id
//   `;

//   const conditions = [];
//   const params = [];

//   // 🔍 Search filter
//   if (searchTerm && searchTerm.trim()) {
//     const term = `%${searchTerm.trim()}%`;
//     conditions.push(`
//       (c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone_number LIKE ? 
//        OR a.address_details LIKE ? OR a.city LIKE ? OR a.state LIKE ? OR a.pin_code LIKE ?)
//     `);
//     params.push(term, term, term, term, term, term, term);
//   }

//   // 🧮 Address count filter → use HAVING
//   let havingClause = "";
//   if (addressCount === "single") {
//     havingClause = "HAVING COUNT(a.id) = 1";
//   } else if (addressCount === "multiple") {
//     havingClause = "HAVING COUNT(a.id) > 1";
//   }

//   // WHERE conditions if any
//   if (conditions.length > 0) {
//     sql += " WHERE " + conditions.join(" AND ");
//   }

//   sql += `
//     GROUP BY c.id
//     ${havingClause}
//     ORDER BY c.id DESC
//   `;

//   db.query(sql, params, (err, results) => {
//     if (err) {
//       console.error("Database error:", err);
//       return res.status(500).json({ error: "Failed to fetch customers." });
//     }

//     // ✅ Safe parse handling
//     const customers = results.map(row => {
//       let addresses = [];
//       try {
//         if (row.addresses) {
//           if (typeof row.addresses === "string") {
//             // MySQL returned JSON string
//             addresses = JSON.parse(row.addresses).filter(addr => addr !== null);
//           } else if (Array.isArray(row.addresses)) {
//             // MySQL already returned JS array
//             addresses = row.addresses.filter(addr => addr !== null);
//           }
//         }
//       } catch (e) {
//         console.warn("Failed to parse addresses for customer", row.id, e);
//       }

//       return {
//         id: row.id,
//         first_name: row.first_name,
//         last_name: row.last_name,
//         phone_number: row.phone_number,
//         address_count: parseInt(row.address_count) || 0,
//         addresses
//       };
//     });

//     res.json({ data: customers });
//   });
// });



// app.get('/api/customers/count', (req, res) => {
//   const { addressCount, q: searchTerm } = req.query;

//   let sql = `
//     SELECT COUNT(*) as total
//     FROM (
//       SELECT c.id
//       FROM customers c
//       LEFT JOIN addresses a ON c.id = a.customer_id
//   `;

//   const conditions = [];
//   const params = [];

//   if (searchTerm && searchTerm.trim()) {
//     const term = `%${searchTerm.trim()}%`;
//     conditions.push(`
//       (c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone_number LIKE ? 
//        OR a.address_details LIKE ? OR a.city LIKE ? OR a.state LIKE ? OR a.pin_code LIKE ?)
//     `);
//     params.push(term, term, term, term, term, term, term);
//   }

//   if (addressCount === 'single') {
//     conditions.push(`a.id IS NOT NULL GROUP BY c.id HAVING COUNT(a.id) = 1`);
//   } else if (addressCount === 'multiple') {
//     conditions.push(`a.id IS NOT NULL GROUP BY c.id HAVING COUNT(a.id) > 1`);
//   }

//   if (conditions.length > 0) {
//     sql += " WHERE " + conditions.join(" AND ");
//   }

//   if (!addressCount) {
//     sql += " GROUP BY c.id";
//   }

//   sql += ") as filtered_customers";

//   db.query(sql, params, (err, results) => {
//     if (err) return res.status(500).json({ error: err.message });
//     res.json({ count: results[0]?.total || 0 });
//   });
// });
// app.post('/api/customers', (req, res) => {
//   const { first_name, last_name, phone_number, address_details, city, state, pin_code } = req.body;

//   // Validation
//   if (!first_name || !last_name || !phone_number || !address_details || !city || !state || !pin_code) {
//     return res.status(400).json({ error: "All fields are required.", field: "general" });
//   }
//   if (!/^\d{10}$/.test(phone_number)) {
//     return res.status(400).json({ error: "Phone number must be 10 digits.", field: "phone_number" });
//   }
//   if (!/^\d{6}$/.test(pin_code)) {
//     return res.status(400).json({ error: "Pin code must be 6 digits.", field: "pin_code" });
//   }

//   db.getConnection((err, connection) => {
//     if (err) return res.status(500).json({ error: "Database connection failed.", field: "general" });

//     // 🔍 Check for duplicate customer by first_name, last_name, phone_number
//     const checkSql = `
//       SELECT id FROM customers 
//       WHERE first_name = ? AND last_name = ? AND phone_number = ?
//     `;
//     connection.query(checkSql, [first_name, last_name, phone_number], (err, results) => {
//       if (err) {
//         connection.release();
//         return res.status(500).json({ error: "Error checking duplicates.", field: "general" });
//       }

//       if (results.length > 0) {
//         connection.release();
//         return res.status(409).json({
//           error: "Customer with this name and phone number already exists.",
//           field: "phone_number",
//         });
//       }

//       // ✅ No duplicate → Proceed with transaction
//       connection.beginTransaction((err) => {
//         if (err) {
//           connection.release();
//           return res.status(500).json({ error: "Transaction failed.", field: "general" });
//         }

//         const customerSql = "INSERT INTO customers (first_name, last_name, phone_number) VALUES (?, ?, ?)";
//         connection.query(customerSql, [first_name, last_name, phone_number], (err, customerResult) => {
//           if (err) {
//             return connection.rollback(() => {
//               connection.release();
//               res.status(500).json({ error: err.message, field: "general" });
//             });
//           }

//           const customerId = customerResult.insertId;
//           const addressSql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES (?, ?, ?, ?, ?)";
//           connection.query(addressSql, [customerId, address_details, city, state, pin_code], (err, addressResult) => {
//             if (err) {
//               return connection.rollback(() => {
//                 connection.release();
//                 res.status(500).json({ error: err.message, field: "general" });
//               });
//             }

//             connection.commit((err) => {
//               if (err) {
//                 return connection.rollback(() => {
//                   connection.release();
//                   res.status(500).json({ error: "Failed to commit transaction.", field: "general" });
//                 });
//               }

//               connection.release();
//               res.status(201).json({
//                 message: "Customer and address created successfully.",
//                 customerId,
//               });
//             });
//           });
//         });
//       });
//     });
//   });
// });

// // 3. Get addresses for a customer
// app.get('/api/customers/:id/addresses', (req, res) => {
//   const sql = "SELECT * FROM addresses WHERE customer_id = ?";
//   db.query(sql, [req.params.id], (err, results) => {
//     if (err) return res.status(500).json({ error: err.message });
//     res.json({ data: results });
//   });
// });

// // 4. Add an address for a customer
// app.post('/api/customers/:id/addresses', (req, res) => {
//   const { address_details, city, state, pin_code } = req.body;

//   // Validate required fields
//   if (!address_details || !city || !state || !pin_code) {
//     return res.status(400).json({ error: "All address fields are required." });
//   }

//   // Validate pin code (6 digits)
//   if (!/^\d{6}$/.test(pin_code)) {
//     return res.status(400).json({ error: "Pin code must be 6 digits." });
//   }

//   const sql = "INSERT INTO addresses (customer_id, address_details, city, state, pin_code) VALUES (?, ?, ?, ?, ?)";
//   db.query(sql, [req.params.id, address_details, city, state, pin_code], (err, result) => {
//     if (err) return res.status(500).json({ error: err.message });
//     res.status(201).json({ message: 'Address added', addressId: result.insertId });
//   });
// });

// // Error handling middleware
// app.use((err, req, res, next) => {
//   console.error(err.stack);
//   res.status(500).json({ error: "Something went wrong!" });
// });

// // Start server
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });


























