<?php
header('Content-Type: application/json'); // Wichtig: JSON-Header setzen
 

 $host = 'localhost';
 $port = '1496';
 $dbname = 'glossar';
 $user = 'tux';
 $password = 'linux';
 

 try {
  $pdo = new PDO("pgsql:host=$host;port=$port;dbname=$dbname", $user, $password);
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
 } catch (PDOException $e) {
  echo json_encode(['error' => 'Verbindungsfehler: ' . $e->getMessage()]);
  die();
 }
 

 $sql = "SELECT * FROM glossar ORDER BY short;";
 $stmt = $pdo->query($sql);
 

 $result = $stmt->fetchAll(PDO::FETCH_ASSOC);
 

 echo json_encode($result); // Daten als JSON ausgeben
 ?>
