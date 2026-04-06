import Foundation

struct APIError: Error {
    let statusCode: Int
}

final class NetworkClient {
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetchJSON(from url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(statusCode: -1)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(statusCode: http.statusCode)
        }
        return data
    }
}
