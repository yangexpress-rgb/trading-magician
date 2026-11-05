-- Routes for feeds added before routes were created automatically. Each active
-- real-provider feed becomes the primary, on any venue, for bars and live
-- prices of the asset classes it covers, wherever the user has no such route.
-- When several feeds qualify, the oldest wins. Existing routes are untouched.
INSERT INTO data_route (user_id, asset_class, venue, data_type, primary_feed_id)
SELECT DISTINCT ON (f.user_id, ac.asset_class, dt.data_type)
       f.user_id, ac.asset_class, NULL, dt.data_type, f.id
  FROM data_feed_connection f
 CROSS JOIN LATERAL unnest(f.asset_classes) AS ac(asset_class)
 CROSS JOIN (VALUES ('bars'::market_data_type), ('quotes'::market_data_type)) AS dt(data_type)
 WHERE f.is_active
   AND f.provider <> 'demo'
 ORDER BY f.user_id, ac.asset_class, dt.data_type, f.created_at
ON CONFLICT DO NOTHING;
