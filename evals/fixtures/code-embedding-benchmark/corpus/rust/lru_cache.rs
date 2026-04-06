use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

pub struct LruCache<K, V>
where
    K: Clone + Eq + Hash,
{
    capacity: usize,
    order: VecDeque<K>,
    items: HashMap<K, V>,
}

impl<K, V> LruCache<K, V>
where
    K: Clone + Eq + Hash,
{
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::new(),
            items: HashMap::new(),
        }
    }

    pub fn put(&mut self, key: K, value: V) {
        if self.items.contains_key(&key) {
            self.order.retain(|item| item != &key);
        } else if self.items.len() == self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.items.remove(&oldest);
            }
        }

        self.order.push_back(key.clone());
        self.items.insert(key, value);
    }
}
