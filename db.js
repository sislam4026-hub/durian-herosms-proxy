const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.json');

class Database {
  constructor() {
    this.data = { activations: {} };
    this.init();
  }

  init() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const fileContent = fs.readFileSync(DB_PATH, 'utf8');
        this.data = JSON.parse(fileContent);
        if (!this.data.activations) {
          this.data.activations = {};
        }
      } else {
        this.saveToFile();
      }
    } catch (error) {
      console.error('Failed to initialize database, using empty state:', error);
      this.data = { activations: {} };
    }
  }

  saveToFile() {
    try {
      const tempPath = DB_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, DB_PATH);
    } catch (error) {
      console.error('Failed to persist database to file:', error);
    }
  }

  get(id) {
    return this.data.activations[id] || null;
  }

  save(id, record) {
    this.data.activations[id] = {
      ...this.data.activations[id],
      ...record,
      id: id,
      updatedAt: Date.now()
    };
    this.saveToFile();
    return this.data.activations[id];
  }

  delete(id) {
    if (this.data.activations[id]) {
      delete this.data.activations[id];
      this.saveToFile();
      return true;
    }
    return false;
  }

  list() {
    return Object.values(this.data.activations);
  }
}

module.exports = new Database();
